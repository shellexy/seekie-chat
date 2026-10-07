import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAnimatedGif, shouldCompressImage, IMAGE_COMPRESS_MIN_BYTES, IMAGE_MAX_SIDE } from '../src/image';

// 手工拼最小 GIF：文件头 + 逻辑屏幕描述 + 可选的应用扩展填充 + 画面块 + 结束符。
function buildGif(frames: number, padding = 0): ArrayBuffer {
  const parts: Buffer[] = [Buffer.from('GIF89a', 'latin1'), Buffer.from([0x10, 0, 0x10, 0, 0, 0, 0])];
  if (padding) {
    parts.push(Buffer.from([0x21, 0xff]));                 // Application Extension
    let left = padding;
    while (left > 0) { const n = Math.min(255, left); parts.push(Buffer.from([n]), Buffer.alloc(n, 0x41)); left -= n; }
    parts.push(Buffer.from([0x00]));
  }
  const frame = () => Buffer.concat([
    Buffer.from([0x2c, 0, 0, 0, 0, 0x10, 0, 0x10, 0, 0]),  // 画面描述：16×16
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00])            // LZW 最小码长 + 数据子块 + 结束
  ]);
  for (let i = 0; i < frames; i++) parts.push(frame());
  parts.push(Buffer.from([0x3b]));
  const buffer = Buffer.concat(parts);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

test('animated GIFs are told apart from static ones', () => {
  assert.equal(isAnimatedGif(buildGif(1)), false, '单帧是静态图');
  assert.equal(isAnimatedGif(buildGif(2)), true, '两帧以上就是动图');
  assert.equal(isAnimatedGif(buildGif(3)), true);
  assert.equal(isAnimatedGif(new ArrayBuffer(0)), false, '空数据不是 GIF');
  assert.equal(isAnimatedGif(new TextEncoder().encode('not a gif at all').buffer as ArrayBuffer), false);
  assert.equal(isAnimatedGif(new TextEncoder().encode('GIF89a truncated').buffer as ArrayBuffer), false);
});

test('only images big enough to be worth re-encoding are compressed', () => {
  assert.equal(shouldCompressImage(IMAGE_COMPRESS_MIN_BYTES - 1), false, '小于 50KB 原样保留');
  assert.equal(shouldCompressImage(IMAGE_COMPRESS_MIN_BYTES), true);
  assert.equal(shouldCompressImage(5 * 1024 * 1024), true);
  assert.equal(IMAGE_MAX_SIDE, 1280);
});
