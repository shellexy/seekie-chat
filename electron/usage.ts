import type { ToolEvent, Usage } from '../src/types';

// Overlapping tools count as one wall-clock interval, so concurrent calls are not subtracted twice.
export function elapsedExcludingToolWait(totalElapsedMs: number, requestStartedAt: number, tools: ToolEvent[], requestEndedAt = requestStartedAt + totalElapsedMs) {
  const intervals = tools.filter(tool => tool.status !== 'pending' && tool.name !== 'google_search').map(tool => {
    const start = Math.max(requestStartedAt, tool.started);
    const end = Math.min(requestEndedAt, tool.started + (tool.elapsed ?? Math.max(0, requestEndedAt - tool.started)));
    return { start, end };
  }).filter(interval => interval.end > interval.start).sort((a, b) => a.start - b.start);
  let removed = 0, activeStart = 0, activeEnd = 0;
  for (const interval of intervals) {
    if (interval.start > activeEnd) { removed += activeEnd - activeStart; activeStart = interval.start; activeEnd = interval.end; }
    else activeEnd = Math.max(activeEnd, interval.end);
  }
  if (activeEnd > activeStart) removed += activeEnd - activeStart;
  return Math.max(0, totalElapsedMs - removed);
}

// Stream usage frames describe cumulative counts within a request, not increments.
export class UsageCounter {
  readonly total: Usage = { input: 0, output: 0 };
  private round: Partial<Usage> = {};
  private cacheKnown = true;

  observe(snapshot: Partial<Usage>) {
    for (const key of ['input', 'output', 'cachedInput'] as const) {
      const value = snapshot[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        this.round[key] = Math.max(this.round[key] ?? 0, value);
      }
    }
  }

  finishRound() {
    this.total.input += this.round.input ?? 0;
    this.total.output += this.round.output ?? 0;
    this.cacheKnown &&= this.round.cachedInput !== undefined;
    if (this.cacheKnown) this.total.cachedInput = (this.total.cachedInput ?? 0) + this.round.cachedInput!;
    else delete this.total.cachedInput;
    this.round = {};
  }
}
