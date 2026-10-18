/**
 * Tracks what happened after a signal, independent of the exit rules: price multiples
 * at fixed checkpoints, max gain, max drawdown and whether it rugged. This is the
 * ground truth the tuner learns from (no lookahead: each value is only written once
 * its time has passed).
 */
export class OutcomeTracker {
  checkpoints = new Map<number, number>(); // minutes → multiple
  maxMultiple = 1;
  minMultiple = 1;
  rugged = false;
  private peak = 0;

  constructor(
    public entryPrice: number,
    public entryTs: number,
    private checkpointMin: number[],
  ) {
    this.peak = entryPrice;
  }

  observe(ts: number, price: number) {
    if (this.entryPrice <= 0) return;
    const m = price / this.entryPrice;
    this.maxMultiple = Math.max(this.maxMultiple, m);
    this.minMultiple = Math.min(this.minMultiple, m);
    this.peak = Math.max(this.peak, price);
    // Rug = −90% from peak (or from entry). Market dumps rarely do that in hours; rugs do.
    if (price <= this.peak * 0.1) this.rugged = true;
    for (const c of this.checkpointMin) {
      if (!this.checkpoints.has(c) && ts - this.entryTs >= c * 60_000) this.checkpoints.set(c, m);
    }
  }

  /** Max drawdown from entry, % (negative). */
  get maxDrawdownPct() {
    return (this.minMultiple - 1) * 100;
  }

  done(ts: number) {
    const last = Math.max(...this.checkpointMin);
    return ts - this.entryTs >= last * 60_000;
  }
}
