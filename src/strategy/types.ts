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

/** Early heads-up: safe so far and building, but not (yet) a buy. */
export interface RadarPing extends Evaluation {
  stage: 'building' | 'near';
  ts: number;
}

export interface Signal extends Evaluation {
  id: string;
  mode: Mode;
  plan: TradePlan;
  ts: number;
  /** Shadow = tracked silently for learning (near-miss score or sampled reject); never alerted. */
  shadow?: boolean;
  /** For sampled rejects: which filters failed. */
  rejectIds?: string[];
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
  /** Updates for silently tracked shadow signals are stored, never sent. */
  shadow?: boolean;
}
