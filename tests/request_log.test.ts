import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestLog } from '../electron/request_log';
import type { RequestRecord } from '../src/types';

const record = (index: number, error?: string): RequestRecord => ({ url: `https://fixture.invalid/v1/round-${index}`, method: 'POST', headers: {}, body: '{}', ...(error ? { error } : {}) });

test('request log keeps the most recent requests of one message', () => {
  const log = new RequestLog(3, 10);
  for (let index = 1; index <= 4; index++) log.add('m', record(index));
  assert.deepEqual(log.get('m').map(item => item.url), [
    'https://fixture.invalid/v1/round-2', 'https://fixture.invalid/v1/round-3', 'https://fixture.invalid/v1/round-4'
  ]);
});

test('request log never evicts a failed request while successful ones remain', () => {
  const log = new RequestLog(3, 10);
  log.add('m', record(1)); log.add('m', record(2, '400 upstream rejected'));
  log.add('m', record(3)); log.add('m', record(4));
  const entries = log.get('m');
  assert.equal(entries.length, 3);
  assert.ok(entries.some(item => item.error === '400 upstream rejected'), '失败的请求必须保留用于排查');
  assert.deepEqual(entries.map(item => item.url), [
    'https://fixture.invalid/v1/round-2', 'https://fixture.invalid/v1/round-3', 'https://fixture.invalid/v1/round-4'
  ]);
  log.add('m', record(5, '500 upstream failed'));
  assert.equal(log.get('m').filter(item => item.error).length, 2, '全部是失败请求时仍按最旧优先淘汰');
});

test('request log forgets the oldest messages and clears on import', () => {
  const log = new RequestLog(2, 2);
  log.add('first', record(1)); log.add('second', record(1)); log.add('third', record(1));
  assert.deepEqual(log.get('first'), []);
  assert.equal(log.get('second').length, 1); assert.equal(log.get('third').length, 1);
  assert.deepEqual(log.get('unknown'), []);
  log.clear();
  assert.deepEqual(log.get('second'), []);
});
