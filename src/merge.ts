import type { AppState, Message } from './types';

// A streaming answer is broadcast as a patch: only the message that is growing is sent. Revision
// numbers make patches safe to apply out of order, and make sure a full state that was produced
// before the newest patch can never push the visible text backwards.
export interface MessagePatch { conversationId: string; message: Message }

const revision = (message: Message) => message.streamRevision ?? 0;

/**
 * Replaces one message with the patched version. Returns null when nothing changed, so the caller can
 * skip a re-render; unknown conversations or messages are ignored rather than created.
 */
export function applyMessagePatch(state: AppState, patch: MessagePatch): AppState | null {
  const conversation = state.conversations.find(c => c.id === patch.conversationId);
  if (!conversation) return null;
  const index = conversation.messages.findIndex(m => m.id === patch.message.id);
  if (index < 0) return null;
  if (revision(conversation.messages[index]) > revision(patch.message)) return null;
  const messages = conversation.messages.slice();
  messages[index] = patch.message;
  return { ...state, conversations: state.conversations.map(c => c === conversation ? { ...c, messages } : c) };
}

/**
 * Keeps locally known streaming text when an authoritative full state is older than the patches that
 * already arrived. Everything else in the incoming state still wins.
 */
export function keepNewerStreaming(local: AppState | undefined, incoming: AppState): AppState {
  if (!local) return incoming;
  const localConversations = new Map(local.conversations.map(c => [c.id, c]));
  for (const conversation of incoming.conversations) {
    const known = localConversations.get(conversation.id); if (!known) continue;
    const knownMessages = new Map(known.messages.map(m => [m.id, m]));
    conversation.messages = conversation.messages.map(message => {
      const previous = knownMessages.get(message.id);
      return previous && revision(previous) > revision(message) ? previous : message;
    });
  }
  return incoming;
}
