import type { PumpTrade, TokenCreated } from '../core/types.js';
import { curvePriceSol, curveProgress } from '../ingest/onchain/pumpfun.js';

/** pump.fun tokens: 1B supply, 6 decimals. */
export const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000n;

export interface WalletPos {
  firstBuySlot: number;
  firstBuyTs: number;
  bought: bigint;
  sold: bigint;
  solIn: bigint;
  solOut: bigint;
  buys: number;
  sells: number;
}

interface TradeRow {
  ts: number;
  slot: number;
  user: string;
  isBuy: boolean;
  sol: bigint;
  priceSol: number;
}

export interface WindowStats {
  buys: number;
  sells: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buySol: number;
  sellSol: number;
}

/**
 * Everything we can derive from pump.fun trade events for one token — these are the
 * on-chain equivalents of GMGN's Bundler / Sniper / Dev metrics, available within
 * seconds of launch and without any API.
 *
 * Holdings are net curve trades per wallet. Wallet-to-wallet transfers are not seen,
 * so `complete` is only true when we observed the creation itself.
 */
export class TokenBook {
  wallets = new Map<string, WalletPos>();
  trades: TradeRow[] = [];
  creator?: string;
  createdSlot?: number;
  createdTs?: number;
  /** True when we saw the CreateEvent, i.e. every trade since launch is in the book. */
  complete = false;
  lastPriceSol = 0;
  athPriceSol = 0;
  realSolReserves = 0n;
  realTokenReserves?: bigint;
  lastTradeTs = 0;
  /** Wallets in the creation slot that are not the creator (classic launch bundle). */
  private bundleSet = new Set<string>();

  constructor(
    public mint: string,
    private maxTrades = 5000,
  ) {}

  onCreate(c: TokenCreated) {
    this.creator = c.creator;
    this.createdSlot = c.slot;
    this.createdTs = c.ts;
    this.complete = this.trades.length === 0;
  }

  onTrade(t: PumpTrade) {
    const priceSol = curvePriceSol(t.virtualSolReserves, t.virtualTokenReserves);
    let w = this.wallets.get(t.user);
    if (!w) {
      w = { firstBuySlot: t.isBuy ? t.slot : Infinity, firstBuyTs: t.isBuy ? t.ts : Infinity, bought: 0n, sold: 0n, solIn: 0n, solOut: 0n, buys: 0, sells: 0 };
      this.wallets.set(t.user, w);
    }
    if (t.isBuy) {
      if (t.slot < w.firstBuySlot) {
        w.firstBuySlot = t.slot;
        w.firstBuyTs = t.ts;
      }
      w.bought += t.tokenAmount;
      w.solIn += t.solAmount;
      w.buys++;
      if (this.createdSlot !== undefined && t.slot === this.createdSlot && t.user !== this.creator) this.bundleSet.add(t.user);
    } else {
      w.sold += t.tokenAmount;
      w.solOut += t.solAmount;
      w.sells++;
    }
    this.trades.push({ ts: t.ts, slot: t.slot, user: t.user, isBuy: t.isBuy, sol: t.solAmount, priceSol });
    if (this.trades.length > this.maxTrades) this.trades.splice(0, this.trades.length - this.maxTrades);
    this.lastPriceSol = priceSol;
    this.athPriceSol = Math.max(this.athPriceSol, priceSol);
    if (t.realSolReserves !== undefined) this.realSolReserves = t.realSolReserves;
    if (t.realTokenReserves !== undefined) this.realTokenReserves = t.realTokenReserves;
    this.lastTradeTs = Math.max(this.lastTradeTs, t.ts);
  }

  net(wallet: string): bigint {
    const w = this.wallets.get(wallet);
    if (!w) return 0n;
    const n = w.bought - w.sold;
    return n > 0n ? n : 0n;
  }

  /** % of total supply currently held (by net curve trades) by `wallets`. */
  pctHeld(wallets: Iterable<string>): number {
    let sum = 0n;
    for (const w of wallets) sum += this.net(w);
    return Number((sum * 1_000_000n) / PUMP_TOTAL_SUPPLY) / 10_000;
  }

  bundleWallets(): string[] {
    return [...this.bundleSet];
  }

  /** Bought within `slots` slots after creation (excluding the creation-slot bundle and the dev). */
  sniperWallets(slots: number): string[] {
    if (this.createdSlot === undefined) return [];
    const out: string[] = [];
    for (const [addr, w] of this.wallets) {
      if (addr === this.creator || this.bundleSet.has(addr)) continue;
      if (w.firstBuySlot > this.createdSlot && w.firstBuySlot <= this.createdSlot + slots) out.push(addr);
    }
    return out;
  }

  devHoldPct(): number | null {
    return this.creator ? this.pctHeld([this.creator]) : null;
  }

  /** Share of the dev's bought tokens that the dev has sold (0–100), null if dev never bought. */
  devSoldPct(): number | null {
    const w = this.creator ? this.wallets.get(this.creator) : undefined;
    if (!w || w.bought === 0n) return null;
    return Number((w.sold * 10_000n) / w.bought) / 100;
  }

  /** Top-N holders by net curve position (the curve itself is not a wallet here). */
  topHoldersPct(n = 10): number {
    const nets = [...this.wallets.keys()].map((w) => this.net(w)).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
    let sum = 0n;
    for (const v of nets.slice(0, n)) sum += v;
    return Number((sum * 1_000_000n) / PUMP_TOTAL_SUPPLY) / 10_000;
  }

  holderCount(): number {
    let n = 0;
    for (const w of this.wallets.keys()) if (this.net(w) > 0n) n++;
    return n;
  }

  uniqueTraders(): number {
    return this.wallets.size;
  }

  txPerTrader(): number {
    return this.wallets.size ? this.trades.length / this.wallets.size : 0;
  }

  window(ms: number, now: number): WindowStats {
    const from = now - ms;
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    const s: WindowStats = { buys: 0, sells: 0, uniqueBuyers: 0, uniqueSellers: 0, buySol: 0, sellSol: 0 };
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const t = this.trades[i]!;
      if (t.ts <= from) break;
      if (t.ts > now) continue;
      if (t.isBuy) {
        s.buys++;
        s.buySol += Number(t.sol) / 1e9;
        buyers.add(t.user);
      } else {
        s.sells++;
        s.sellSol += Number(t.sol) / 1e9;
        sellers.add(t.user);
      }
    }
    s.uniqueBuyers = buyers.size;
    s.uniqueSellers = sellers.size;
    return s;
  }

  /** Price `ms` ago (the last trade at or before that time), for change % calculations. */
  priceAt(ts: number): number | null {
    for (let i = this.trades.length - 1; i >= 0; i--) if (this.trades[i]!.ts <= ts) return this.trades[i]!.priceSol;
    return null;
  }

  progress(): number | null {
    return this.realTokenReserves === undefined ? null : curveProgress(this.realTokenReserves);
  }

  ageSec(now: number): number | null {
    return this.createdTs === undefined ? null : (now - this.createdTs) / 1000;
  }
}

/** Bounded collection of TokenBooks (least-recently-traded evicted). */
export class TradeBooks {
  private books = new Map<string, TokenBook>();
  constructor(private maxBooks = 5000) {}

  get(mint: string): TokenBook | undefined {
    return this.books.get(mint);
  }

  private ensure(mint: string): TokenBook {
    let b = this.books.get(mint);
    if (b) {
      this.books.delete(mint);
      this.books.set(mint, b); // move to most-recent
      return b;
    }
    b = new TokenBook(mint);
    this.books.set(mint, b);
    if (this.books.size > this.maxBooks) this.books.delete(this.books.keys().next().value as string);
    return b;
  }

  onCreate(c: TokenCreated) {
    this.ensure(c.mint).onCreate(c);
  }
  onTrade(t: PumpTrade) {
    this.ensure(t.mint).onTrade(t);
  }
  get size() {
    return this.books.size;
  }
}
