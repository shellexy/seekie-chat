import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLruCache } from '../src/lru';

test('the payload cache forgets the least recently used entry first', () => {
  const cache = createLruCache(2, 1024);
  cache.set('a', 'aaaa');
  cache.set('b', 'bbbb');
  // 读取 a 之后，最久未用的变成 b。
  assert.equal(cache.get('a'), 'aaaa');
  cache.set('c', 'cccc');
  assert.equal(cache.get('b'), undefined, '最久未用的应先被淘汰');
  assert.equal(cache.get('a'), 'aaaa');
  assert.equal(cache.get('c'), 'cccc');
  assert.equal(cache.size, 2);
});

test('the payload cache also respects a byte budget', () => {
  const cache = createLruCache(100, 10);
  cache.set('a', '12345');
  cache.set('b', '67890');
  assert.equal(cache.bytes, 10);
  cache.set('c', 'x');
  assert.equal(cache.get('a'), undefined, '超预算时淘汰最旧的');
  assert.equal(cache.bytes, 6);
  // 单项就超预算时仍要留住它，否则连一张图都显示不出来。
  cache.set('huge', 'x'.repeat(50));
  assert.equal(cache.get('huge')?.length, 50);
  assert.equal(cache.size, 1);
});

test('writing the same key again replaces its payload instead of double counting', () => {
  const cache = createLruCache(4, 100);
  cache.set('a', '1111');
  cache.set('a', '22');
  assert.equal(cache.bytes, 2);
  assert.equal(cache.get('a'), '22');
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});
