import type { Usage } from '../src/types';

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
