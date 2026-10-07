import { test } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastDelay, LONG_STREAM_BROADCAST_MS, LONG_STREAM_CHARS, STREAM_BROADCAST_MS } from '../electron/broadcast';

test('streaming broadcasts slow down only after an answer grows long', () => {
  assert.equal(broadcastDelay(), STREAM_BROADCAST_MS, '短回答保持流畅');
  assert.equal(broadcastDelay(0), STREAM_BROADCAST_MS);
  assert.equal(broadcastDelay(LONG_STREAM_CHARS), STREAM_BROADCAST_MS, '恰好到阈值时仍按快节奏');
  assert.equal(broadcastDelay(LONG_STREAM_CHARS + 1), LONG_STREAM_BROADCAST_MS, '超过阈值后降频');
  assert.equal(broadcastDelay(500_000), LONG_STREAM_BROADCAST_MS);
  assert.ok(STREAM_BROADCAST_MS >= 50 && STREAM_BROADCAST_MS <= 100, '快节奏不应慢于 100ms');
  assert.ok(LONG_STREAM_BROADCAST_MS >= 250 && LONG_STREAM_BROADCAST_MS <= 1000, '慢节奏应在 0.25-1 秒之间');
});
