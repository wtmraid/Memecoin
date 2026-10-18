import { describe, expect, it } from 'vitest';
import { TokenBook, TradeBooks } from '../src/analysis/tradeBook.js';
import type { PumpTrade, TokenCreated } from '../src/core/types.js';

const DEV = 'dev';
const created: TokenCreated = { mint: 'M', name: 'n', symbol: 'S', uri: '', bondingCurve: 'bc', creator: DEV, venue: 'pumpfun', signature: 's', slot: 100, ts: 0 };
const M = 1_000_000n; // 1 token = 1e6 raw
const trade = (user: string, isBuy: boolean, tokens: bigint, slot: number, ts: number, sol = 1_000_000_000n): PumpTrade => ({
  mint: 'M', user, isBuy, solAmount: sol, tokenAmount: tokens * M,
  virtualSolReserves: 30_000_000_000n + BigInt(ts), virtualTokenReserves: 1_073_000_000_000_000n,
  realSolReserves: 5_000_000_000n, realTokenReserves: 700_000_000_000_000n, signature: `${user}${ts}`, slot, ts,
});

function launch() {
  const b = new TokenBook('M');
  b.onCreate(created);
  b.onTrade(trade(DEV, true, 30_000_000n, 100, 0)); // dev 3%
  b.onTrade(trade('b1', true, 50_000_000n, 100, 0)); // bundle 5%
  b.onTrade(trade('b2', true, 50_000_000n, 100, 0)); // bundle 5%
  b.onTrade(trade('s1', true, 20_000_000n, 102, 800)); // sniper 2%
  b.onTrade(trade('late', true, 10_000_000n, 150, 20_000)); // 1%
  return b;
}

describe('TokenBook', () => {
  it('detects the creation-slot bundle (excluding the dev) and its supply share', () => {
    const b = launch();
    expect(b.complete).toBe(true);
    expect(b.bundleWallets().sort()).toEqual(['b1', 'b2']);
    expect(b.pctHeld(b.bundleWallets())).toBe(10);
  });

  it('snipers = first buy within N slots after creation', () => {
    const b = launch();
    expect(b.sniperWallets(3)).toEqual(['s1']);
    expect(b.sniperWallets(100).sort()).toEqual(['late', 's1']);
  });

  it('tracks dev holdings and how much the dev sold', () => {
    const b = launch();
    expect(b.devHoldPct()).toBe(3);
    b.onTrade(trade(DEV, false, 15_000_000n, 200, 30_000));
    expect(b.devHoldPct()).toBe(1.5);
    expect(b.devSoldPct()).toBe(50);
  });

  it('bundle selling shows up in their holdings', () => {
    const b = launch();
    b.onTrade(trade('b1', false, 50_000_000n, 300, 40_000));
    expect(b.pctHeld(b.bundleWallets())).toBe(5);
  });

  it('top holders, holder count and tx/trader', () => {
    const b = launch();
    expect(b.topHoldersPct(2)).toBe(10);
    expect(b.holderCount()).toBe(5);
    expect(b.txPerTrader()).toBe(1);
  });

  it('windows count buys/sells/unique buyers', () => {
    const b = launch();
    b.onTrade(trade('x', false, 1n, 400, 60_000));
    const w = b.window(60_000, 60_000); // (0, 60s]
    expect(w).toMatchObject({ buys: 2, sells: 1, uniqueBuyers: 2, uniqueSellers: 1 }); // s1 (0.8s), late (20s), x sell (60s)
  });

  it('marks the book incomplete if trades arrived before we saw the create', () => {
    const b = new TokenBook('M');
    b.onTrade(trade('early', true, 1n, 100, 0));
    b.onCreate(created);
    expect(b.complete).toBe(false);
  });

  it('priceAt returns the last price at or before a time', () => {
    const b = launch();
    expect(b.priceAt(10_000)).toBe(b.trades[3]!.priceSol);
    expect(b.priceAt(-1)).toBeNull();
  });
});

describe('TradeBooks', () => {
  it('evicts the least recently traded token', () => {
    const books = new TradeBooks(2);
    books.onTrade({ ...trade('u', true, 1n, 1, 0), mint: 'A' });
    books.onTrade({ ...trade('u', true, 1n, 1, 0), mint: 'B' });
    books.onTrade({ ...trade('u', true, 1n, 1, 0), mint: 'A' });
    books.onTrade({ ...trade('u', true, 1n, 1, 0), mint: 'C' });
    expect(books.get('B')).toBeUndefined();
    expect(books.get('A')).toBeDefined();
  });
});
