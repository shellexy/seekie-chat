import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TOOL_CALL_LIMIT, currentDateTime, datetimeTool, geminiDatetimeTool, localToolsEnabled,
  recordToolCall, remainingToolCalls, toolCallLimit, toolCallLimitError, toolRoundBudget
} from '../electron/local_tools';
import type { ChatConfig, Model } from '../src/types';

const model: Model = { id: 'm', connectionId: 'c', name: 'Mock', model: 'fixture', contextWindow: 100000, maxOutput: 4096, vision: true, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true };
const config = { modelId: 'm', system: '', search: 'off', effort: 'auto', budget: 1024 } as ChatConfig;

test('datetime returns one concise line with weekday, zone, offset and the UTC instant', () => {
  const now = new Date(Date.UTC(2026, 9, 15, 12, 43, 7));
  const text = currentDateTime(now);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 星期[日一二三四五六] \| \S+ UTC[+-]\d{2}:\d{2} \| UTC 2026-10-15T12:43:07Z$/);
  assert.equal(text.split('\n').length, 1, 'the model should receive a single line');
  const [localPart, zonePart, utcPart] = text.split(' | ');
  assert.equal(utcPart, 'UTC 2026-10-15T12:43:07Z', 'UTC keeps seconds and drops millisecond noise');
  assert.ok(localPart.endsWith(`星期${['日', '一', '二', '三', '四', '五', '六'][now.getDay()]}`), localPart);
  // The wall clock must be the UTC instant shifted by exactly the advertised offset.
  const [date, time] = localPart.split(' '), [year, month, day] = date.split('-').map(Number), [hour, minute, second] = time.split(':').map(Number);
  const offset = /UTC([+-])(\d{2}):(\d{2})/.exec(zonePart)!;
  const offsetMinutes = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
  assert.equal(Date.UTC(year, month - 1, day, hour, minute, second) - now.getTime(), offsetMinutes * 60_000);
});

test('every tool keeps its own call budget and stops being usable at the limit', () => {
  assert.equal(toolCallLimit('datetime'), DEFAULT_TOOL_CALL_LIMIT);
  assert.equal(toolCallLimit('web_fetch'), DEFAULT_TOOL_CALL_LIMIT);
  assert.equal(toolCallLimit('some_future_tool'), DEFAULT_TOOL_CALL_LIMIT, 'new tools inherit the default budget');
  const counts = new Map<string, number>();
  assert.equal(remainingToolCalls(counts, 'datetime'), DEFAULT_TOOL_CALL_LIMIT);
  for (let call = 0; call < DEFAULT_TOOL_CALL_LIMIT; call++) assert.equal(recordToolCall(counts, 'datetime'), true);
  assert.equal(recordToolCall(counts, 'datetime'), false);
  assert.equal(remainingToolCalls(counts, 'datetime'), 0);
  assert.equal(remainingToolCalls(counts, 'web_fetch'), DEFAULT_TOOL_CALL_LIMIT, 'one tool must not consume another tool budget');
  assert.match(toolCallLimitError('datetime'), new RegExp(`${DEFAULT_TOOL_CALL_LIMIT} 次`));
  assert.equal(toolRoundBudget(['datetime', 'web_fetch']), DEFAULT_TOOL_CALL_LIMIT * 2 + 1);
});

test('local tools stay off without tool support or when a background request disables them', () => {
  assert.equal(localToolsEnabled(model, config), true);
  assert.equal(localToolsEnabled({ ...model, tools: false }, config), false);
  assert.equal(localToolsEnabled(model, { ...config, localTools: false }), false);
  assert.deepEqual(datetimeTool.parameters, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.equal(geminiDatetimeTool.name, datetimeTool.name);
  assert.equal(geminiDatetimeTool.parameters.type, 'OBJECT', 'Gemini needs its uppercase schema dialect');
});
