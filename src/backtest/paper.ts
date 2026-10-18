import type { StrategySettings } from '../config/strategy.js';

export interface PaperFill {
  ts: number;
  side: 'buy' | 'sell';
  /** % of original position (sells) or 100 (buy). */
  pct: number;
  marketPrice: number;
  fillPrice: number;
  reason: string;
}

/**
 * Realistic-ish paper fills. Every leg pays slippage + venue fee; every transaction pays
 * a priority fee + Jito tip (fixed SOL, so it hurts small positions more).
 */
export class PaperPosition {
  fills: PaperFill[] = [];
  private entryFill = 0;
  private realized = 0; // Σ (pct/100 × exitFill/entryFill)
  private txCount = 0;

  constructor(private s: StrategySettings['paper']) {}

  buy(ts: number, marketPrice: number) {
    this.entryFill = marketPrice * (1 + this.s.slippagePct / 100) * (1 + this.s.venueFeePct / 100);
    this.txCount++;
    this.fills.push({ ts, side: 'buy', pct: 100, marketPrice, fillPrice: this.entryFill, reason: 'entry' });
  }

  sell(ts: number, pct: number, marketPrice: number, reason: string) {
    if (!this.entryFill || pct <= 0) return;
    const fill = marketPrice * (1 - this.s.slippagePct / 100) * (1 - this.s.venueFeePct / 100);
    this.realized += (pct / 100) * (fill / this.entryFill);
    this.txCount++;
    this.fills.push({ ts, side: 'sell', pct, marketPrice, fillPrice: fill, reason });
  }

  get entryPrice() {
    return this.entryFill;
  }

  /** Net P&L % on the SOL committed, after fixed per-tx costs. Unsold remainder valued at `markPrice` (0 = rugged). */
  pnlPct(remainingPct = 0, markPrice = 0): number {
    const open = this.entryFill ? (remainingPct / 100) * ((markPrice * (1 - this.s.slippagePct / 100)) / this.entryFill) : 0;
    const fixed = (this.txCount * (this.s.priorityFeeSol + this.s.jitoTipSol)) / this.s.positionSol;
    return ((this.realized + open - fixed - 1) * 100);
  }
}
