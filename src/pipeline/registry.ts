import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { BondingCurveState, HolderStats, MarketSnapshot, PumpTrade, Venue } from '../core/types.js';
import { curvePriceSol, curveProgress } from '../ingest/onchain/pumpfun.js';

export interface TrackedToken {
  mint: string;
  firstSeen: number;
  venue?: Venue;
  createdMs?: number;
  bondingCurve?: string;
  onCurve: boolean;
  complete: boolean;
  migrated: boolean;
  lastActivity: number;
  lastMarketAt: number;
  lastHoldersAt: number;
  lastCurveAt: number;
  market?: MarketSnapshot;
  holders?: HolderStats;
  curve?: BondingCurveState;
}

export interface RegistryDeps {
  marketSnapshots(mints: string[]): Promise<Map<string, MarketSnapshot>>;
  holderStats?(mint: string): Promise<HolderStats>;
  bondingCurve?(mint: string): Promise<BondingCurveState | null>;
}

export interface RegistryOptions {
  trackMaxAgeSec: number;
  maxTrackedTokens: number;
  marketRefreshSec: number;
  holdersRefreshSec: number;
  curveRefreshSec: number;
  holdersPerCycle: number;
  /** Min ms between curve events derived from trades for the same mint. */
  curveFromTradeThrottleMs: number;
}

/**
 * Owns the set of tokens we are actively watching and keeps their market, holder and
 * curve data fresh within API budgets. Youngest / most recently active tokens first.
 */
export class TokenRegistry {
  readonly tokens = new Map<string, TrackedToken>();
  private timers: NodeJS.Timeout[] = [];
  private busy = { market: false, holders: false, curve: false };

  constructor(
    private bus: EventBus,
    private deps: RegistryDeps,
    private log: Logger,
    private opts: RegistryOptions,
    private now: () => number = Date.now,
  ) {
    bus.on('token.created', (t) =>
      this.track(t.mint, { venue: t.venue, createdMs: t.ts, bondingCurve: t.bondingCurve, onCurve: t.venue === 'pumpfun' }),
    );
    bus.on('pool.created', (p) => {
      this.track(p.baseMint, { venue: p.venue, createdMs: p.ts });
    });
    bus.on('token.discovered', (d) => this.track(d.mint, {}));
    bus.on('wallet.trade', (w) => w.side === 'buy' && this.track(w.mint, {}));
    bus.on('social.mention', (m) => m.mints.forEach((mint) => this.track(mint, {})));
    bus.on('pumpfun.trade', (t) => this.onTrade(t));
    bus.on('pumpfun.complete', (c) => {
      const t = this.tokens.get(c.mint);
      if (t) {
        t.complete = true;
        t.lastActivity = this.now();
      }
    });
    bus.on('pumpfun.migrated', (m) => {
      const t = this.track(m.mint, {});
      t.migrated = true;
      t.complete = true;
      t.onCurve = false;
    });
  }

  track(mint: string, info: Partial<TrackedToken>): TrackedToken {
    const now = this.now();
    let t = this.tokens.get(mint);
    if (!t) {
      t = {
        mint,
        firstSeen: now,
        onCurve: false,
        complete: false,
        migrated: false,
        lastActivity: now,
        lastMarketAt: -Infinity,
        lastHoldersAt: -Infinity,
        lastCurveAt: -Infinity,
      };
      this.tokens.set(mint, t);
      this.evictIfFull();
    }
    for (const [k, v] of Object.entries(info)) if (v !== undefined && (t as any)[k] === undefined) (t as any)[k] = v;
    if (info.onCurve) t.onCurve = true;
    t.lastActivity = now;
    return t;
  }

  /** Trade events carry the curve reserves, so curve state is free — no RPC needed. */
  private onTrade(tr: PumpTrade) {
    const t = this.tokens.get(tr.mint);
    if (!t) return;
    t.lastActivity = this.now();
    if (tr.realTokenReserves === undefined) return;
    if (this.now() - t.lastCurveAt < this.opts.curveFromTradeThrottleMs) return;
    t.lastCurveAt = this.now();
    const curve: BondingCurveState = {
      mint: tr.mint,
      virtualSolReserves: tr.virtualSolReserves,
      virtualTokenReserves: tr.virtualTokenReserves,
      realTokenReserves: tr.realTokenReserves,
      realSolReserves: tr.realSolReserves ?? 0n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      complete: t.complete,
      progress: t.complete ? 1 : curveProgress(tr.realTokenReserves),
      priceSol: curvePriceSol(tr.virtualSolReserves, tr.virtualTokenReserves),
    };
    t.curve = curve;
    this.bus.emit('pumpfun.curve', curve);
  }

  private evictIfFull() {
    if (this.tokens.size <= this.opts.maxTrackedTokens) return;
    let oldest: TrackedToken | undefined;
    for (const t of this.tokens.values()) if (!oldest || t.lastActivity < oldest.lastActivity) oldest = t;
    if (oldest) this.tokens.delete(oldest.mint);
  }

  expire() {
    const cutoff = this.now() - this.opts.trackMaxAgeSec * 1000;
    for (const [mint, t] of this.tokens) if (t.lastActivity < cutoff) this.tokens.delete(mint);
  }

  /** Newest / most active first. */
  prioritized(): TrackedToken[] {
    return [...this.tokens.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async refreshMarket() {
    if (this.busy.market) return;
    this.busy.market = true;
    try {
      const due = this.prioritized().filter((t) => this.now() - t.lastMarketAt >= this.opts.marketRefreshSec * 1000);
      if (!due.length) return;
      const snaps = await this.deps.marketSnapshots(due.map((t) => t.mint));
      const now = this.now();
      for (const t of due) t.lastMarketAt = now;
      for (const [mint, s] of snaps) {
        const t = this.tokens.get(mint);
        if (t) t.market = s;
        this.bus.emit('market.snapshot', s);
      }
    } catch (err) {
      this.log.warn({ err: String(err) }, 'market refresh failed');
    } finally {
      this.busy.market = false;
    }
  }

  async refreshHolders() {
    if (this.busy.holders || !this.deps.holderStats) return;
    this.busy.holders = true;
    try {
      const due = this.prioritized()
        .filter((t) => this.now() - t.lastHoldersAt >= this.opts.holdersRefreshSec * 1000)
        .slice(0, this.opts.holdersPerCycle);
      for (const t of due) {
        t.lastHoldersAt = this.now();
        try {
          const h = await this.deps.holderStats(t.mint);
          t.holders = h;
          this.bus.emit('holders.snapshot', h);
        } catch (err) {
          this.log.debug({ mint: t.mint, err: String(err) }, 'holder fetch failed');
        }
      }
    } finally {
      this.busy.holders = false;
    }
  }

  /** RPC curve reads only for curve tokens without a recent trade-derived state. */
  async refreshCurves() {
    if (this.busy.curve || !this.deps.bondingCurve) return;
    this.busy.curve = true;
    try {
      const due = this.prioritized().filter(
        (t) => t.onCurve && !t.complete && this.now() - t.lastCurveAt >= this.opts.curveRefreshSec * 1000,
      );
      for (const t of due.slice(0, 20)) {
        t.lastCurveAt = this.now();
        try {
          const c = await this.deps.bondingCurve(t.mint);
          if (!c) continue;
          t.curve = c;
          if (c.complete) t.complete = true;
          this.bus.emit('pumpfun.curve', c);
        } catch (err) {
          this.log.debug({ mint: t.mint, err: String(err) }, 'curve fetch failed');
        }
      }
    } finally {
      this.busy.curve = false;
    }
  }

  start() {
    const every = (sec: number, fn: () => unknown) => this.timers.push(setInterval(fn, sec * 1000));
    every(Math.max(2, this.opts.marketRefreshSec / 4), () => this.refreshMarket());
    every(Math.max(5, this.opts.holdersRefreshSec / 8), () => this.refreshHolders());
    every(Math.max(3, this.opts.curveRefreshSec / 3), () => this.refreshCurves());
    every(60, () => this.expire());
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}
