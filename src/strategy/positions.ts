import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { StrategySettings } from '../config/strategy.js';
import type { SeriesStore, SolPrice } from '../analysis/context.js';
import type { TradeBooks } from '../analysis/tradeBook.js';
import { OutcomeTracker } from '../backtest/outcomes.js';
import { PaperPosition } from '../backtest/paper.js';
import type { MarketSnapshot } from '../core/types.js';
import { WSOL_MINT } from '../ingest/onchain/programs.js';
import type { TokenRegistry } from '../pipeline/registry.js';
import { applyExits, checkEmergency, evaluateExits, type Observation, type PositionState } from './exits.js';
import type { Signal, SignalUpdate } from './types.js';

export interface ClosedOutcome {
  signalId: string;
  mint: string;
  checkpoints: Record<number, number>;
  maxMultiple: number;
  maxDrawdownPct: number;
  rugged: boolean;
  /** null = no trade (entry window missed). */
  pnlPct: number | null;
  closedTs: number | null;
  /** First time a rug-in-progress condition appeared (even after the position closed). */
  emergencyTs: number | null;
  emergencyReason: string | null;
}

interface Pos {
  signal: Signal;
  state: PositionState;
  paper: PaperPosition;
  outcome: OutcomeTracker;
  creator?: string;
  bundle: string[];
  /** Waiting for the simulated reaction latency before the paper entry fills. */
  pendingEntryUntil: number;
  missed: boolean;
  closedTs: number | null;
  migrated: boolean;
  lastPrice: number;
  lastObsTs: number;
  lastPathTs: number;
  emergency: { ts: number; reason: string } | null;
}

/**
 * Follows every signal (and, silently, every shadow signal): paper-trades it with the
 * exit rules and sends sell recommendations (`signal.update`) as they trigger. Keeps
 * tracking after the paper position closes until the last outcome checkpoint (24h),
 * recording the price path and the first rug-warning — that's what `npm run tune` replays.
 */
export class PositionMonitor {
  /** By signal id. */
  readonly positions = new Map<string, Pos>();
  private byMint = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private bus: EventBus,
    private registry: TokenRegistry,
    private books: TradeBooks,
    private sol: SolPrice,
    private series: SeriesStore,
    private s: StrategySettings,
    private log: Logger,
    private hooks: {
      refreshMarket?: (mints: string[]) => Promise<Map<string, MarketSnapshot>>;
      onOutcome?: (o: ClosedOutcome) => void;
      /** Price path sample (≤ every 5 s for the first hour, then every 60 s). */
      onPrice?: (signalId: string, ts: number, price: number) => void;
    } = {},
    private now: () => number = Date.now,
  ) {
    bus.on('signal.buy', (sig) => this.open(sig));
    bus.on('signal.shadow', (sig) => this.open(sig));
    bus.on('pumpfun.trade', (t) => {
      for (const p of this.forMint(t.mint)) if (!p.migrated) this.observe(p, this.books.get(t.mint)?.lastPriceSol ?? 0);
    });
    bus.on('market.snapshot', (m) => {
      for (const p of this.forMint(m.mint)) if (p.migrated || !this.books.get(m.mint)?.lastPriceSol) this.observe(p, this.priceFromSnapshot(m) ?? 0, m);
    });
    const onMigrate = (mint: string) => {
      const ps = this.forMint(mint);
      for (const p of ps) p.migrated = true;
      if (ps.length) this.series.delete(`liq:${mint}`); // curve → pool liquidity is a different series
    };
    bus.on('pumpfun.complete', (c) => onMigrate(c.mint));
    bus.on('pumpfun.migrated', (m) => onMigrate(m.mint));
  }

  private forMint(mint: string): Pos[] {
    const ids = this.byMint.get(mint);
    return ids ? [...ids].map((id) => this.positions.get(id)!).filter(Boolean) : [];
  }

  private priceFromSnapshot(m: MarketSnapshot): number | null {
    if (m.priceNative && (m.quoteMint === WSOL_MINT || m.quoteMint === undefined)) return m.priceNative;
    if (m.priceUsd && this.sol.usd) return m.priceUsd / this.sol.usd;
    return null;
  }

  get shadowCount() {
    let n = 0;
    for (const p of this.positions.values()) if (p.signal.shadow) n++;
    return n;
  }

  open(sig: Signal) {
    const existing = this.forMint(sig.mint);
    // One live alert per coin at a time; a shadow never duplicates anything.
    if (existing.some((p) => !p.signal.shadow && p.closedTs === null)) return;
    if (sig.shadow && (existing.length || this.shadowCount >= this.s.maxShadowPositions)) return;
    const book = this.books.get(sig.mint);
    const now = this.now();
    const entry = sig.plan.entryPrice;
    const p: Pos = {
      signal: sig,
      state: {
        entryPrice: entry,
        entryTs: now,
        peakPrice: entry,
        remainingPct: 100,
        tp1Done: false,
        tp2Done: false,
        migrationDone: false,
        devTokensAtEntry: null,
        bundleTokensAtEntry: null,
        belowStopSince: null,
        stopPrice: entry * (1 - this.s.exit.stopLossPct / 100),
      },
      paper: new PaperPosition(this.s.paper),
      outcome: new OutcomeTracker(entry, now, this.s.outcomeCheckpointsMin),
      creator: book?.creator,
      bundle: book?.complete ? book.bundleWallets() : [],
      pendingEntryUntil: now + this.s.paper.latencyMs,
      missed: false,
      closedTs: null,
      migrated: sig.facts.migrated,
      lastPrice: entry,
      lastObsTs: now,
      lastPathTs: 0,
      emergency: null,
    };
    if (book?.complete && p.creator) {
      p.state.devTokensAtEntry = book.net(p.creator);
      p.state.bundleTokensAtEntry = p.bundle.reduce((a, w) => a + book.net(w), 0n);
    }
    this.positions.set(sig.id, p);
    this.byMint.set(sig.mint, new Set([...(this.byMint.get(sig.mint) ?? []), sig.id]));
    this.hooks.onPrice?.(sig.id, now, entry);
  }

  private observation(p: Pos, price: number, m?: MarketSnapshot): Observation {
    const now = this.now();
    const mint = p.signal.mint;
    const book = this.books.get(mint);
    const o: Observation = { now, price, migrated: p.migrated };
    if (book?.complete && !p.migrated) {
      if (p.creator) o.devTokens = book.net(p.creator);
      if (p.bundle.length) o.bundleTokens = p.bundle.reduce((a, w) => a + book.net(w), 0n);
      const w = book.window(120_000, now);
      o.buys2m = w.buys;
      o.sells2m = w.sells;
    }
    const liq = m?.liquidityUsd ?? this.registry.tokens.get(mint)?.market?.liquidityUsd ?? null;
    if (p.migrated || !book) {
      o.liquidityUsd = liq;
      o.liquidityUsd5mAgo = this.series.at(`liq:${mint}`, now - 300_000);
    }
    return o;
  }

  observe(p: Pos, price: number, m?: MarketSnapshot) {
    if (!(price > 0)) return;
    const now = this.now();
    p.lastPrice = price;
    p.lastObsTs = now;
    this.registry.track(p.signal.mint, {}); // keep it alive in the registry
    p.outcome.observe(now, price);
    const age = now - p.state.entryTs;
    if (now - p.lastPathTs >= (age < 3600_000 ? 5000 : 60_000)) {
      p.lastPathTs = now;
      this.hooks.onPrice?.(p.signal.id, now, price);
    }
    const obs = this.observation(p, price, m);
    if (!p.emergency) {
      const reason = checkEmergency(p.state, obs, this.s);
      if (reason) p.emergency = { ts: now, reason };
    }

    if (p.paper.entryPrice === 0 && !p.missed) {
      if (now < p.pendingEntryUntil) return;
      // The alert says "don't chase above +X%". If it already ran past that before a
      // human could act, the honest paper result is: no trade.
      if (price > p.signal.plan.maxEntryPrice) {
        p.missed = true;
        p.closedTs = now;
        this.emit(p, 'missed_entry', 0, `price ran +${((price / p.state.entryPrice - 1) * 100).toFixed(0)}% before you could enter — don't chase; wait for a pullback or skip`);
      } else p.paper.buy(now, price);
    }
    if (p.closedTs === null) {
      const actions = evaluateExits(p.state, obs, this.s);
      p.state = applyExits(p.state, actions, price, now);
      for (const a of actions) {
        p.paper.sell(now, a.sellPct, price, a.reason);
        this.emit(p, a.kind, a.sellPct, a.reason);
      }
      if (p.state.remainingPct === 0) {
        p.closedTs = now;
        this.emit(p, 'closed', 0, `position closed — paper P&L ${fmtPct(p.paper.pnlPct())} after fees, slippage & tips`);
      }
    }
    if (p.outcome.done(now)) this.finish(p);
  }

  private emit(p: Pos, kind: SignalUpdate['kind'], sellPct: number, reason: string) {
    const mult = p.lastPrice / p.state.entryPrice;
    const mkt = this.registry.tokens.get(p.signal.mint)?.market;
    const mcap = p.migrated && mkt?.marketCapUsd ? mkt.marketCapUsd : this.sol.usd ? p.lastPrice * 1e9 * this.sol.usd : null;
    this.bus.emit('signal.update', {
      signalId: p.signal.id,
      mint: p.signal.mint,
      symbol: p.signal.facts.symbol,
      kind,
      sellPct,
      remainingPct: p.missed ? 0 : p.state.remainingPct,
      price: p.lastPrice,
      multiple: mult,
      mcapUsd: mcap,
      reason,
      pnlPct: p.missed ? 0 : p.paper.pnlPct(p.state.remainingPct, p.lastPrice),
      ts: this.now(),
      shadow: p.signal.shadow,
    });
  }

  private finish(p: Pos) {
    this.hooks.onOutcome?.({
      signalId: p.signal.id,
      mint: p.signal.mint,
      checkpoints: Object.fromEntries(p.outcome.checkpoints),
      maxMultiple: p.outcome.maxMultiple,
      maxDrawdownPct: p.outcome.maxDrawdownPct,
      rugged: p.outcome.rugged,
      pnlPct: p.missed ? null : p.paper.pnlPct(p.state.remainingPct, p.outcome.rugged ? 0 : p.lastPrice),
      closedTs: p.closedTs,
      emergencyTs: p.emergency?.ts ?? null,
      emergencyReason: p.emergency?.reason ?? null,
    });
    this.positions.delete(p.signal.id);
    const ids = this.byMint.get(p.signal.mint);
    ids?.delete(p.signal.id);
    if (ids && !ids.size) this.byMint.delete(p.signal.mint);
  }

  /** Periodic: time-based rules and DEX price refresh for migrated / non-pump tokens. */
  async tick() {
    const dex = [...new Set([...this.positions.values()].filter((p) => p.migrated || !this.books.get(p.signal.mint)?.lastPriceSol).map((p) => p.signal.mint))];
    if (dex.length && this.hooks.refreshMarket) {
      try {
        for (const [, m] of await this.hooks.refreshMarket(dex)) this.bus.emit('market.snapshot', m);
      } catch (err) {
        this.log.debug({ err: String(err) }, 'position market refresh failed');
      }
    }
    // Re-run rules on the last price so time stops fire even without new trades.
    for (const p of [...this.positions.values()]) this.observe(p, p.lastPrice);
  }

  openSummary(): string[] {
    return [...this.positions.values()]
      .filter((p) => !p.signal.shadow)
      .map((p) => {
        const m = p.lastPrice / p.state.entryPrice;
        const state = p.missed ? ' (entry missed, tracking outcome)' : p.closedTs ? ' (closed, tracking outcome)' : '';
        return `${p.signal.facts.symbol ?? p.signal.mint.slice(0, 6)} ${p.signal.mode} ${m.toFixed(2)}x, ${p.state.remainingPct.toFixed(0)}% held${state}`;
      });
  }

  /** Live (non-shadow) positions still being traded. */
  get openCount() {
    let n = 0;
    for (const p of this.positions.values()) if (!p.signal.shadow && p.closedTs === null) n++;
    return n;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 5000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

export const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
