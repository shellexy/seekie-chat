import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkForTokens, estimateTextTokens } from '../src/domain';
import { condenseToBudget } from '../electron/condense';

test('chunkForTokens keeps every chunk inside the token budget and loses no text', () => {
  const paragraph = '这是一段资料，包含数字 12345 与名称。\n\n';
  const text = paragraph.repeat(400); // 约 1.1 万字符
  const chunks = chunkForTokens(text, 2000);
  assert.ok(chunks.length > 1, '长文本应被切成多块');
  for (const chunk of chunks) assert.ok(estimateTextTokens(chunk) <= 2000, `块内 token 超预算：${estimateTextTokens(chunk)}`);
  // 只允许丢掉断点处的空行，正文不能少。
  assert.equal(chunks.join('').replace(/\n/g, '').length, text.replace(/\n/g, '').length);
});

test('chunkForTokens leaves a short text alone', () => {
  assert.deepEqual(chunkForTokens('很短的一段', 4000), ['很短的一段']);
});

test('condenseToBudget reduces an oversized message until it fits', async () => {
  const material = '资料正文。'.repeat(30_000); // 约 18 万字符
  const summarized: number[] = [];
  const result = await condenseToBudget(material, 4000, 20_000, async text => {
    summarized.push(text.length);
    return text.slice(0, 400);
  });
  assert.ok(summarized.length > 1, '应该分块摘要，而不是一次搞定');
  assert.ok(estimateTextTokens(result) <= 4000, `摘要后仍超预算：${estimateTextTokens(result)}`);
  assert.match(result, /【第 1\/\d+ 段摘要】/);
});

test('condenseToBudget gives up loudly when summarising cannot shrink anything', async () => {
  const material = '不压缩。'.repeat(20_000);
  await assert.rejects(
    () => condenseToBudget(material, 500, 2000, async text => text),
    /分段摘要后仍有约 .* token/,
  );
});
