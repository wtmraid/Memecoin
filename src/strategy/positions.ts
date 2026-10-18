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
import { applyExits, evaluateExits, type Observation, type PositionState } from './exits.js';
import type { Signal, SignalUpdate } from './types.js';

export interface ClosedOutcome {
  signalId: string;
  mint: string;
  checkpoints: Record<number, number>;
  maxMultiple: number;
  maxDrawdownPct: number;
  rugged: boolean;
  pnlPct: number;
  closedTs: number | null;
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
  closedTs: number | null;
  migrated: boolean;
  lastPrice: number;
  lastObsTs: number;
}

/**
 * Follows every signal: paper-trades it with the exit rules and sends sell
 * recommendations (`signal.update`) as they trigger. Keeps tracking after the paper
 * position is closed until the last outcome checkpoint (24h) so the logged outcome is
 * complete — that's the dataset `npm run report` and the tuner learn from.
 */
export class PositionMonitor {
  readonly positions = new Map<string, Pos>(); // by mint
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
    } = {},
    private now: () => number = Date.now,
  ) {
    bus.on('signal.buy', (sig) => this.open(sig));
    bus.on('pumpfun.trade', (t) => {
      const p = this.positions.get(t.mint);
      if (p && !p.migrated) this.observe(p, this.books.get(t.mint)?.lastPriceSol ?? 0);
    });
    bus.on('market.snapshot', (m) => {
      const p = this.positions.get(m.mint);
      if (p && (p.migrated || !this.books.get(m.mint)?.lastPriceSol)) this.observe(p, this.priceFromSnapshot(m) ?? 0, m);
    });
    const onMigrate = (mint: string) => {
      const p = this.positions.get(mint);
      if (p) {
        p.migrated = true;
        this.series.delete(`liq:${mint}`); // curve → pool liquidity is a different series
      }
    };
    bus.on('pumpfun.complete', (c) => onMigrate(c.mint));
    bus.on('pumpfun.migrated', (m) => onMigrate(m.mint));
  }

  private priceFromSnapshot(m: MarketSnapshot): number | null {
    if (m.priceNative && (m.quoteMint === WSOL_MINT || m.quoteMint === undefined)) return m.priceNative;
    if (m.priceUsd && this.sol.usd) return m.priceUsd / this.sol.usd;
    return null;
  }

  open(sig: Signal) {
    if (this.positions.has(sig.mint)) return;
    const book = this.books.get(sig.mint);
    const now = this.now();
    const p: Pos = {
      signal: sig,
      state: {
        entryPrice: sig.plan.entryPrice,
        entryTs: now,
        peakPrice: sig.plan.entryPrice,
        remainingPct: 100,
        tp1Done: false,
        tp2Done: false,
        migrationDone: false,
        devTokensAtEntry: null,
        bundleTokensAtEntry: null,
      },
      paper: new PaperPosition(this.s.paper),
      outcome: new OutcomeTracker(sig.plan.entryPrice, now, this.s.outcomeCheckpointsMin),
      creator: book?.creator,
      bundle: book?.complete ? book.bundleWallets() : [],
      pendingEntryUntil: now + this.s.paper.latencyMs,
      closedTs: null,
      migrated: sig.facts.migrated,
      lastPrice: sig.plan.entryPrice,
      lastObsTs: now,
    };
    if (book?.complete && p.creator) {
      p.state.devTokensAtEntry = book.net(p.creator);
      p.state.bundleTokensAtEntry = p.bundle.reduce((a, w) => a + book.net(w), 0n);
    }
    this.positions.set(sig.mint, p);
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

    if (p.paper.entryPrice === 0) {
      if (now < p.pendingEntryUntil) return;
      p.paper.buy(now, price);
    }
    if (p.closedTs === null) {
      const actions = evaluateExits(p.state, this.observation(p, price, m), this.s);
      p.state = applyExits(p.state, actions, price);
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
      remainingPct: p.state.remainingPct,
      price: p.lastPrice,
      multiple: mult,
      mcapUsd: mcap,
      reason,
      pnlPct: p.paper.pnlPct(p.state.remainingPct, p.lastPrice),
      ts: this.now(),
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
      pnlPct: p.paper.pnlPct(p.state.remainingPct, p.outcome.rugged ? 0 : p.lastPrice),
      closedTs: p.closedTs,
    });
    this.positions.delete(p.signal.mint);
  }

  /** Periodic: time-based rules and DEX price refresh for migrated / non-pump tokens. */
  async tick() {
    const dex = [...this.positions.values()].filter((p) => p.migrated || !this.books.get(p.signal.mint)?.lastPriceSol).map((p) => p.signal.mint);
    if (dex.length && this.hooks.refreshMarket) {
      try {
        for (const [, m] of await this.hooks.refreshMarket(dex)) this.bus.emit('market.snapshot', m);
      } catch (err) {
        this.log.debug({ err: String(err) }, 'position market refresh failed');
      }
    }
    for (const p of [...this.positions.values()]) {
      // Re-run rules on the last price so time stops fire even without new trades.
      // No trades for 10+ minutes on a curve token means it died: mark at last price.
      this.observe(p, p.lastPrice);
    }
  }

  openSummary(): string[] {
    return [...this.positions.values()].map((p) => {
      const m = p.lastPrice / p.state.entryPrice;
      return `${p.signal.facts.symbol ?? p.signal.mint.slice(0, 6)} ${p.signal.mode} ${m.toFixed(2)}x, ${p.state.remainingPct.toFixed(0)}% held${p.closedTs ? ' (closed, tracking outcome)' : ''}`;
    });
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 5000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

export const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
