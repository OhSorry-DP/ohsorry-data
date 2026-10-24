import { AwsClient } from "aws4fetch";

export type R2S3Options = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  onRequest?: (event: { operation: "GET" | "HEAD" | "PUT"; attempt: 1 }) => void;
};

export type R2S3Result<T> = { status: number; value?: T; etag: string | null };

export class R2S3HttpError extends Error {
  status: number;
  operation: string;
  constructor(status: number, operation: string) {
    super(`R2 S3 ${operation} failed with HTTP ${status}`);
    this.name = "R2S3HttpError";
    this.status = status;
    this.operation = operation;
  }
}

export class R2S3TransportError extends Error {
  operation: string;
  outcomeUnknown: boolean;
  constructor(operation: string, outcomeUnknown: boolean, cause: unknown) {
    super(`R2 S3 ${operation} transport failed${outcomeUnknown ? "; PUT outcome unknown" : ""}`, { cause });
    this.name = "R2S3TransportError";
    this.operation = operation;
    this.outcomeUnknown = outcomeUnknown;
  }
}

const encodePathPart = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function createR2S3Adapter(options: R2S3Options, AwsClientImpl: typeof AwsClient = AwsClient) {
  const { accountId, accessKeyId, secretAccessKey, bucket, fetchImpl, onRequest } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (![accountId, accessKeyId, secretAccessKey, bucket].every(v => typeof v === "string" && v.length > 0)) throw new Error("R2 S3 credentials and bucket are required");
  if (typeof fetchImpl !== "function") throw new Error("R2 S3 fetchImpl is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");

  const signer = new AwsClientImpl({ accessKeyId, secretAccessKey, region: "auto", service: "s3" });
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  async function request(operation: "GET" | "HEAD" | "PUT", key: string, init: RequestInit = {}, consume?: (response: Response) => Promise<unknown>) {
    const path = [bucket, ...key.split("/")].map(encodePathPart).join("/");
    const url = `${endpoint}/${path}`;
    const headers = new Headers(init.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    onRequest?.({ operation, attempt: 1 });
    try {
      const signed = await signer.sign(url, { ...init, method: operation, headers, signal: controller.signal });
      const requestWithTimeout = new Request(signed, { signal: controller.signal });
      const response = await fetchImpl(requestWithTimeout);
      if (consume) return { response, value: await consume(response) };
      return response;
    } catch (error) {
      throw new R2S3TransportError(operation, operation === "PUT", error);
    } finally {
      clearTimeout(timer);
    }
  }

  async function checked(operation: "GET" | "HEAD" | "PUT", key: string, init: RequestInit = {}) {
    const response = await request(operation, key, init);
    if (!response.ok) throw new R2S3HttpError(response.status, operation);
    return response;
  }

  return {
    async get(key: string): Promise<R2S3Result<Uint8Array>> {
    const result = await request("GET", key, {}, response => response.arrayBuffer()) as { response: Response; value: ArrayBuffer };
      const { response, value } = result;
      if (!response.ok) throw new R2S3HttpError(response.status, "GET");
      return { status: response.status, value: new Uint8Array(value), etag: response.headers.get("etag") };
    },
    async head(key: string): Promise<R2S3Result<Headers>> {
      const response = await checked("HEAD", key);
      return { status: response.status, value: response.headers, etag: response.headers.get("etag") };
    },
    async put(key: string, body: Uint8Array, conditions: { ifMatch?: string; ifNoneMatch?: string } = {}): Promise<R2S3Result<never>> {
      const headers = new Headers();
      if (conditions.ifMatch !== undefined) headers.set("if-match", conditions.ifMatch);
      if (conditions.ifNoneMatch !== undefined) headers.set("if-none-match", conditions.ifNoneMatch);
      const response = await checked("PUT", key, { body: new Uint8Array(body), headers });
      return { status: response.status, etag: response.headers.get("etag") };
    },
  };
}
