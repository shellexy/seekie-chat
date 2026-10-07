import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMessagePatch, keepNewerStreaming } from '../src/merge';
import { addMessage, createConversation, initialState, uid } from '../src/domain';
import type { AppState, Message } from '../src/types';

function fixture() {
  const state = initialState();
  const conversation = createConversation(state.settings);
  addMessage(conversation, conversation.branches[0], 'user', '问题');
  const answer = addMessage(conversation, conversation.branches[0], 'assistant', '');
  answer.status = 'streaming';
  state.conversations = [conversation]; state.selectedId = conversation.id;
  return { state, conversation, answer };
}

test('a patch replaces exactly one message and leaves everything else identical', () => {
  const { state, conversation, answer } = fixture();
  const other = state.conversations[0].messages[0];
  const patched: Message = { ...answer, text: '流式片段', streamRevision: 3 };
  const next = applyMessagePatch(state, { conversationId: conversation.id, message: patched });
  assert.ok(next, '补丁应当生效');
  assert.equal(next.conversations[0].messages[1].text, '流式片段');
  assert.equal(next.conversations[0].messages[1].streamRevision, 3);
  assert.equal(next.conversations[0].messages[0], other, '其它消息对象保持同一引用');
  assert.equal(state.conversations[0].messages[1].text, '', '不得就地修改原状态');
});

test('a patch that is older than what is displayed is dropped', () => {
  const { state, conversation, answer } = fixture();
  const applied = applyMessagePatch(state, { conversationId: conversation.id, message: { ...answer, text: '新文本', streamRevision: 5 } })!;
  assert.equal(applyMessagePatch(applied, { conversationId: conversation.id, message: { ...answer, text: '旧文本', streamRevision: 4 } }), null, '过期补丁必须忽略');
  assert.equal(applyMessagePatch(applied, { conversationId: conversation.id, message: { ...answer, text: '同样新', streamRevision: 5 } })?.conversations[0].messages[1].text, '同样新', '同一修订号按最新内容处理');
  assert.equal(applyMessagePatch(applied, { conversationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', message: { ...answer, streamRevision: 9 } }), null);
  assert.equal(applyMessagePatch(applied, { conversationId: conversation.id, message: { ...answer, id: uid(), streamRevision: 9 } }), null, '未知消息不得凭空创建');
});

test('an authoritative state never pushes streamed text backwards', () => {
  const { state, conversation, answer } = fixture();
  const streamed = applyMessagePatch(state, { conversationId: conversation.id, message: { ...answer, text: '已经显示到这里', streamRevision: 7 } })!;
  // The renderer saved earlier and the response carried the text as it was back then.
  const server: AppState = structuredClone(state);
  server.conversations[0].messages[1] = { ...answer, text: '只有一半', status: 'complete', usage: { input: 1, output: 2 } };
  server.conversations[0].title = '新标题';
  const merged = keepNewerStreaming(streamed, server);
  assert.equal(merged.conversations[0].messages[1].text, '已经显示到这里', '不得回退到更旧的文本');
  // A message is replaced as a whole: its fields belong to one revision, so mixing a newer text with
  // an older status would describe a state that never existed. The final full state carries the
  // highest revision, which is why the completed status still reaches the renderer.
  assert.equal(merged.conversations[0].messages[1].status, 'streaming');
  assert.equal(merged.conversations[0].messages[1].usage, undefined);
  assert.equal(merged.conversations[0].title, '新标题', '会话标题等其他内容仍以服务端为准');
  // Without a newer local revision the server is authoritative.
  const refreshed: AppState = structuredClone(state);
  refreshed.conversations[0].messages[1] = { ...answer, text: '服务端文本', streamRevision: 8 };
  assert.equal(keepNewerStreaming(streamed, refreshed).conversations[0].messages[1].text, '服务端文本');
  assert.equal(keepNewerStreaming(undefined, refreshed).conversations[0].messages[1].text, '服务端文本', '没有本地状态时直接采用');
  assert.equal(keepNewerStreaming(streamed, structuredClone(streamed)).conversations[0].messages[1].text, '已经显示到这里');
});
