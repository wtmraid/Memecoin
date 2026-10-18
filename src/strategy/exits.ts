import type { StrategySettings } from '../config/strategy.js';

export type ExitKind = 'stop_loss' | 'tp1' | 'tp2' | 'trailing_stop' | 'time_stop' | 'migration' | 'emergency' | 'max_hold' | 'missed_entry';

export interface ExitAction {
  kind: ExitKind;
  /** % of the ORIGINAL position to sell now. */
  sellPct: number;
  price: number;
  reason: string;
}

export interface PositionState {
  entryPrice: number;
  entryTs: number;
  peakPrice: number;
  /** % of original position still held (100 → 0). */
  remainingPct: number;
  tp1Done: boolean;
  tp2Done: boolean;
  migrationDone: boolean;
  /** Snapshot at signal time, for emergency rules. */
  devTokensAtEntry: bigint | null;
  bundleTokensAtEntry: bigint | null;
  /** When price first went below the stop (cleared when it recovers). */
  belowStopSince?: number | null;
  /** Absolute stop price, for the confirmation clock. */
  stopPrice?: number;
}

export interface Observation {
  now: number;
  price: number;
  devTokens?: bigint | null;
  bundleTokens?: bigint | null;
  liquidityUsd?: number | null;
  liquidityUsd5mAgo?: number | null;
  buys2m?: number | null;
  sells2m?: number | null;
  migrated?: boolean;
}

/**
 * Pure exit-rule engine. Given the position and one new observation, returns the sells
 * to recommend now (possibly none) and mutates nothing — the caller applies them.
 * Order matters: emergencies and stops pre-empt profit-taking.
 */
export function evaluateExits(p: PositionState, o: Observation, s: StrategySettings): ExitAction[] {
  if (p.remainingPct <= 0) return [];
  const e = s.exit;
  const mult = o.price / p.entryPrice;
  const peak = Math.max(p.peakPrice, o.price);
  const fromPeakPct = (1 - o.price / peak) * 100;
  const all = (kind: ExitKind, reason: string): ExitAction[] => [{ kind, sellPct: p.remainingPct, price: o.price, reason }];

  // --- Emergencies: the rug playbook is already running. Sell everything.
  const em = checkEmergency(p, o, s);
  if (em) return all('emergency', em);

  // --- Stops
  const stop = 1 - e.stopLossPct / 100;
  if (mult <= stop) {
    const crash = mult <= stop * (1 - e.hardStopExtraPct / 100);
    const held = p.belowStopSince != null && o.now - p.belowStopSince >= e.stopConfirmSec * 1000;
    if (crash || held || e.stopConfirmSec <= 0) return all('stop_loss', `stop-loss: ${((mult - 1) * 100).toFixed(0)}% from entry`);
  }
  if (p.tp1Done && fromPeakPct >= e.trailingStopPct)
    return all('trailing_stop', `trailing stop: −${fromPeakPct.toFixed(0)}% from peak ${(peak / p.entryPrice).toFixed(2)}x`);
  const heldMin = (o.now - p.entryTs) / 60_000;
  if (!p.tp1Done && heldMin >= e.timeStopMin && mult < 1 + e.timeStopMinGainPct / 100)
    return all('time_stop', `time stop: only ${((mult - 1) * 100).toFixed(0)}% after ${Math.round(heldMin)} min`);
  if (heldMin >= e.maxHoldHours * 60) return all('max_hold', `max hold ${e.maxHoldHours}h reached`);

  // --- Profit taking (can fire more than one level on a gap up)
  const out: ExitAction[] = [];
  let remaining = p.remainingPct;
  if (!p.tp1Done && mult >= e.tp1Multiple) {
    const pct = Math.min(remaining, e.tp1SellPct);
    out.push({ kind: 'tp1', sellPct: pct, price: o.price, reason: `TP1 hit: ${mult.toFixed(2)}x` });
    remaining -= pct;
  }
  if (!p.tp2Done && mult >= e.tp2Multiple && remaining > 0) {
    const pct = Math.min(remaining, e.tp2SellPct);
    out.push({ kind: 'tp2', sellPct: pct, price: o.price, reason: `TP2 hit: ${mult.toFixed(2)}x` });
    remaining -= pct;
  }
  if (!p.migrationDone && o.migrated && mult > 1 && remaining > 0) {
    const pct = (remaining * e.migrationSellPct) / 100;
    if (pct > 0) out.push({ kind: 'migration', sellPct: pct, price: o.price, reason: `migrated at ${mult.toFixed(2)}x — migration dumps are common, de-risk` });
  }
  return out;
}

/**
 * Rug-in-progress detection, independent of position size (also used to log the first
 * emergency after a paper position is already closed, for the tuner). Returns a reason or null.
 */
export function checkEmergency(p: PositionState, o: Observation, s: StrategySettings): string | null {
  const e = s.exit;
  const peak = Math.max(p.peakPrice, o.price);
  const fromPeakPct = (1 - o.price / peak) * 100;
  if (p.devTokensAtEntry && p.devTokensAtEntry > 0n && o.devTokens !== undefined && o.devTokens !== null) {
    const sold = Number(((p.devTokensAtEntry - o.devTokens) * 10_000n) / p.devTokensAtEntry) / 100;
    if (sold >= e.devSellPct) return (`dev sold ${sold.toFixed(0)}% of their bag`);
  }
  if (p.bundleTokensAtEntry && p.bundleTokensAtEntry > 0n && o.bundleTokens !== undefined && o.bundleTokens !== null) {
    const sold = Number(((p.bundleTokensAtEntry - o.bundleTokens) * 10_000n) / p.bundleTokensAtEntry) / 100;
    if (sold >= e.bundleExodusPct) return (`launch bundle wallets dumped ${sold.toFixed(0)}% of their tokens`);
  }
  if (o.liquidityUsd && o.liquidityUsd5mAgo && o.liquidityUsd5mAgo > 0) {
    const drop = (1 - o.liquidityUsd / o.liquidityUsd5mAgo) * 100;
    if (drop >= e.liquidityDropPct) return (`liquidity −${drop.toFixed(0)}% in 5 min (pull)`);
  }
  if (o.buys2m !== undefined && o.buys2m !== null && o.sells2m && fromPeakPct >= e.sellPressureDrawdownPct) {
    if (o.sells2m >= e.sellPressureRatio * Math.max(1, o.buys2m))
      return (`sell wall: ${o.sells2m} sells vs ${o.buys2m} buys (2m), −${fromPeakPct.toFixed(0)}% from peak`);
  }

  return null;
}

/** Apply actions to state (returns a new state). */
export function applyExits(p: PositionState, actions: ExitAction[], price: number, now?: number): PositionState {
  const n = { ...p, peakPrice: Math.max(p.peakPrice, price) };
  // Stop-confirmation clock: starts when price first dips below the stop, resets on recovery.
  if (now !== undefined && p.stopPrice !== undefined) {
    n.belowStopSince = price <= p.stopPrice ? (p.belowStopSince ?? now) : null;
  }
  for (const a of actions) {
    n.remainingPct = Math.max(0, n.remainingPct - a.sellPct);
    if (a.kind === 'tp1') n.tp1Done = true;
    if (a.kind === 'tp2') n.tp2Done = true;
    if (a.kind === 'migration') n.migrationDone = true;
  }
  if (n.remainingPct < 1e-9) n.remainingPct = 0;
  return n;
}
