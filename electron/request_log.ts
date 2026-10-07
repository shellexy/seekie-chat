import type { RequestRecord } from '../src/types';

// Per-message request log for the in-app debug view. Memory only: it is never persisted in the
// database, never included in exports or backups, and the bodies arrive already redacted.
export class RequestLog {
  private entries = new Map<string, RequestRecord[]>();
  constructor(private perMessage = 12, private messages = 200) {}
  add(messageId: string, entry: RequestRecord) {
    let list = this.entries.get(messageId);
    if (!list) {
      list = []; this.entries.set(messageId, list);
      // Oldest messages leave first: the selected conversation is what the user is looking at.
      while (this.entries.size > this.messages) this.entries.delete(this.entries.keys().next().value!);
    }
    if (list.length >= this.perMessage) {
      // Drop the oldest request that did not fail, so a rejected request is never the one evicted.
      const index = list.findIndex(item => !item.error);
      list.splice(index < 0 ? 0 : index, 1);
    }
    list.push(entry);
  }
  get(messageId: string) { return this.entries.get(messageId) || []; }
  clear() { this.entries.clear(); }
}
