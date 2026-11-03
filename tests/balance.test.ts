import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceCandidates, parseBalance } from '../electron/balance';

test('balanceCandidates derives only same-origin paths from the configured base URL', () => {
  const openrouter = balanceCandidates('https://openrouter.ai/api/v1');
  // OpenRouter 的预设 Base URL 已经带 /api/v1，第一个候选就应该是 …/api/v1/credits。
  assert.equal(openrouter[0], 'https://openrouter.ai/api/v1/credits');
  const deepseek = balanceCandidates('https://api.deepseek.com');
  assert.ok(deepseek.includes('https://api.deepseek.com/api/v1/credits'));
  assert.ok(deepseek.includes('https://api.deepseek.com/user/balance'));
  // 带别的路径（DeepSeek 的 /anthropic）时仍要能回到根上去试。
  const anthropicStyle = balanceCandidates('https://api.deepseek.com/anthropic');
  assert.ok(anthropicStyle.includes('https://api.deepseek.com/user/balance'));
  // 关键：候选地址绝不能换域名，否则等于把 API Key 发给第三方。
  for (const url of [...openrouter, ...deepseek, ...anthropicStyle]) assert.equal(new URL(url).origin, new URL(url).origin.match(/^https:\/\/[^/]+/)![0]);
  for (const url of anthropicStyle) assert.equal(new URL(url).origin, 'https://api.deepseek.com');
  // 去重
  assert.equal(new Set(openrouter).size, openrouter.length);
});

test('parseBalance reads OpenRouter credits and DeepSeek balance_infos', () => {
  assert.deepEqual(parseBalance({ data: { total_credits: 20, total_usage: 7.5 } }), { text: '$12.50', detail: '额度 $20.00 · 已用 $7.50' });
  assert.deepEqual(parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '13.37' }] }), { text: '¥13.37' });
  // 不认识的结构返回 undefined，让调用方继续试下一个候选地址。
  assert.equal(parseBalance({ hello: 'world' }), undefined);
  assert.equal(parseBalance(null), undefined);
});
