import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeFastPending } from './pending-marker.mjs';

test('creates a marker and leaves since fixed for the same generation', () => {
  const created = mergeFastPending({ unknown: 'kept' }, { generation: '7', since: '2026-10-24T00:00:00.000Z' });
  assert.equal(created.ok, true);
  assert.equal(created.marker.generation, '7');
  assert.equal(created.marker.unknown, 'kept');
  const same = mergeFastPending(created.marker, { generation: '7', since: 'ignored' });
  assert.equal(same.ok, true);
  assert.equal(same.marker.since, created.marker.since);
});

test('higher generation advances since monotonically and removes done', () => {
  const marker = { generation: '8', since: '2999-01-01T00:00:00.000Z', done: '2999-01-01T00:00:00.000Z' };
  const result = mergeFastPending(marker, { generation: '9', since: '2026-10-24T00:00:00.000Z' });
  assert.equal(result.ok, true);
  assert.ok(Date.parse(result.marker.since) > Date.parse(marker.since));
  assert.equal(Object.hasOwn(result.marker, 'done'), false);
});

test('lower generation and completion for an older marker are no-ops', () => {
  const marker = { generation: '10', since: '2026-10-24T00:00:00.000Z', done: '2026-10-24T00:00:01.000Z' };
  const lower = mergeFastPending(marker, { generation: '9', since: marker.since });
  const late = mergeFastPending(marker, { generation: '9', since: marker.since, done: '2026-10-24T00:00:02.000Z' });
  assert.equal(lower.ok, false);
  assert.equal(late.ok, false);
  assert.deepEqual(marker, { generation: '10', since: '2026-10-24T00:00:00.000Z', done: '2026-10-24T00:00:01.000Z' });
});

test('preserves unknown fields and rejects invalid time or generation', () => {
  const marker = { generation: '1', since: '2026-10-24T00:00:00.000Z', extra: { keep: true } };
  const completed = mergeFastPending(marker, { generation: '1', since: marker.since, done: marker.since });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.marker.extra, marker.extra);
  assert.equal(mergeFastPending(marker, { generation: '01', since: marker.since }).ok, false);
  assert.equal(mergeFastPending(marker, { generation: '2', since: 'bad' }).ok, false);
  assert.equal(mergeFastPending({ ...marker, since: 'bad' }, { generation: '2', since: marker.since }).ok, false);
});

test('completion uses the maximum of since, server time, and valid future done', () => {
  const marker = { generation: '3', since: '2026-10-24T00:00:00.000Z', done: '2999-01-01T00:00:00.000Z' };
  const result = mergeFastPending(marker, { generation: '3', since: marker.since, done: marker.since });
  assert.equal(result.ok, true);
  assert.equal(result.marker.done, marker.done);
});

test('completion requires matching generation and since', () => {
  const marker = { generation: '4', since: '2026-10-24T00:00:00.000Z' };
  assert.equal(mergeFastPending(marker, { generation: '4', since: '2026-10-24T00:00:01.000Z', done: marker.since }).ok, false);
  assert.equal(mergeFastPending(marker, { generation: '5', since: marker.since, done: marker.since }).ok, false);
});
