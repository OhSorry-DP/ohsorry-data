import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 모델은 워커마다 한 번 전달하고 유저별 요청에는 행과 메타데이터만 보낸다.
export function createFitPool(model, size = os.availableParallelism()) {
  if (!Number.isInteger(size) || size < 1) throw new Error('워커 수는 양의 정수여야 합니다');
  const slots = [], queue = [];
  let failure = null, closed = false;
  const fail = error => {
    failure ||= error;
    for (const slot of slots) {
      slot.task?.reject(failure); slot.task = null;
    }
    for (const task of queue.splice(0)) task.reject(failure);
  };
  const dispatch = slot => {
    if (closed || failure || slot.task || !queue.length) return;
    slot.task = queue.shift();
    try { slot.worker.postMessage(slot.task.input); }
    catch (error) { fail(error); }
  };
  try {
    for (let i = 0; i < size; i++) {
      const slot = { worker: new Worker(new URL(import.meta.url), { workerData: { model } }), task: null };
      slots.push(slot);
      slot.worker.on('error', fail);
      slot.worker.on('exit', code => { if (!closed) fail(new Error(`fit 워커 조기 종료: ${code}`)); });
      slot.worker.on('message', message => {
        const task = slot.task;
        if (!task) return;
        slot.task = null;
        if (message.error) task.reject(new Error(message.error));
        else task.resolve(message.result);
        dispatch(slot);
      });
    }
  } catch (error) {
    closed = true;
    for (const slot of slots) void slot.worker.terminate();
    throw error;
  }
  return {
    fitUser(input) {
      if (closed || failure) return Promise.reject(failure || new Error('fit 풀이 종료되었습니다'));
      const { model: ignored, ...taskInput } = input;
      return new Promise((resolve, reject) => {
        queue.push({ input: taskInput, resolve, reject });
        for (const slot of slots) dispatch(slot);
      });
    },
    async close() {
      closed = true;
      fail(new Error('fit 풀이 종료되었습니다'));
      await Promise.all(slots.map(slot => slot.worker.terminate()));
    },
  };
}

if (!isMainThread) {
  const { fitUser } = require('./vendor/physTheta.js');
  parentPort.on('message', async input => {
    try { parentPort.postMessage({ result: await fitUser({ ...input, model: workerData.model }, { concurrency: 1 }) }); }
    catch (error) { parentPort.postMessage({ error: String(error.stack || error) }); }
  });
}
