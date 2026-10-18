import type { TokenFacts } from '../filters/facts.js';
import type { FilterReport } from '../filters/filters.js';
import type { ScoreResult } from '../scoring/score.js';
import type { ExitKind } from './exits.js';
import type { Mode, TradePlan } from './plan.js';

export interface Evaluation {
  mint: string;
  facts: TokenFacts;
  filters: FilterReport;
  score: ScoreResult;
  mode: Mode | null;
  modeReasons: string[];
  plan: TradePlan | null;
  /** Ready to alert: mode + filters + score + coverage all OK. */
  actionable: boolean;
  /** One-line verdict for /scan replies. */
  verdict: string;
}

export interface Signal extends Evaluation {
  id: string;
  mode: Mode;
  plan: TradePlan;
  ts: number;
}

export interface SignalUpdate {
  signalId: string;
  mint: string;
  symbol?: string;
  kind: ExitKind | 'closed';
  /** % of original position to sell now. */
  sellPct: number;
  remainingPct: number;
  price: number;
  multiple: number;
  mcapUsd: number | null;
  reason: string;
  /** Paper P&L so far (closed positions: final). */
  pnlPct: number;
  ts: number;
}
