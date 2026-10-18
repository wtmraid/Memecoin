import type { EventBus } from '../core/bus.js';
import { WSOL_MINT } from '../ingest/onchain/programs.js';

/** SOL/USD from any SOL-quoted pair we see (priceUsd / priceNative). */
export class SolPrice {
  usd: number | null = null;
  updatedAt = 0;
  constructor(bus?: EventBus) {
    bus?.on('market.snapshot', (s) => {
      if (s.quoteMint === WSOL_MINT && s.priceUsd && s.priceNative) this.update(s.priceUsd / s.priceNative, s.ts);
    });
  }
  update(v: number, ts = Date.now()) {
    if (!Number.isFinite(v) || v < 5 || v > 10_000) return; // ignore garbage ratios
    // Light smoothing: one odd pair shouldn't move it much.
    this.usd = this.usd === null ? v : this.usd * 0.8 + v * 0.2;
    this.updatedAt = ts;
  }
}

/** Counts per key inside a sliding window (creator launches/24h, smart-wallet buys/1h …). */
export class WindowCounter {
  private m = new Map<string, number[]>();
  constructor(private windowMs: number) {}
  add(key: string, ts = Date.now()) {
    const a = this.m.get(key) ?? [];
    a.push(ts);
    this.m.set(key, a);
  }
  count(key: string, now = Date.now()) {
    const a = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (a.length) this.m.set(key, a);
    else this.m.delete(key);
    return a.length;
  }
  prune(now = Date.now()) {
    for (const k of [...this.m.keys()]) this.count(k, now);
  }
}

/** Small time series per key (liquidity, holders) for growth calculations. */
export class SeriesStore {
  private m = new Map<string, { ts: number; v: number }[]>();
  constructor(private maxAgeMs = 3600_000) {}
  push(key: string, v: number, ts = Date.now()) {
    const a = (this.m.get(key) ?? []).filter((x) => ts - x.ts < this.maxAgeMs);
    a.push({ ts, v });
    this.m.set(key, a);
  }
  /** Value at or before `ts` (oldest available if none that old). */
  at(key: string, ts: number): number | null {
    const a = this.m.get(key);
    if (!a?.length) return null;
    let best = a[0]!;
    for (const x of a) if (x.ts <= ts) best = x;
    return best.ts <= ts ? best.v : null;
  }
  latest(key: string): number | null {
    const a = this.m.get(key);
    return a?.length ? a[a.length - 1]!.v : null;
  }
  delete(key: string) {
    this.m.delete(key);
  }
}

/** Async cache with TTL and in-flight de-duplication. */
export class TtlCache<T> {
  private m = new Map<string, { v: T; exp: number }>();
  private inflight = new Map<string, Promise<T>>();
  constructor(private ttlMs: number) {}
  peek(key: string): T | undefined {
    const e = this.m.get(key);
    return e && e.exp > Date.now() ? e.v : undefined;
  }
  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.peek(key);
    if (hit !== undefined) return hit;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = load()
      .then((v) => {
        this.m.set(key, { v, exp: Date.now() + this.ttlMs });
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
