import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/bus.js';
import { OnchainIngestor, type LogSource } from '../src/ingest/onchain/ingestor.js';
import { PROGRAM_IDS, WSOL_MINT } from '../src/ingest/onchain/programs.js';
import type { SolanaRpc } from '../src/ingest/onchain/rpc.js';
import { Recorder } from '../src/pipeline/recorder.js';
import { TokenRegistry, type RegistryOptions } from '../src/pipeline/registry.js';
import { Store } from '../src/storage/db.js';
import { mapDexScreenerPair } from '../src/ingest/market/dexscreener.js';
import type { LogNotification, MarketSnapshot } from '../src/core/types.js';
import { completeEventData, createEventData, key, logsFor, migrationEventData, MINT, parsedTx, silent, tb, tradeEventData } from './helpers.js';

const opts: RegistryOptions = {
  trackMaxAgeSec: 60,
  maxTrackedTokens: 3,
  marketRefreshSec: 10,
  holdersRefreshSec: 10,
  curveRefreshSec: 10,
  holdersPerCycle: 2,
  curveFromTradeThrottleMs: 0,
};

class FakeSource implements LogSource {
  handlers = new Map<string, (n: LogNotification) => void>();
  onLogs(address: string, cb: (n: LogNotification) => void) {
    this.handlers.set(address, cb);
    return () => this.handlers.delete(address);
  }
}

describe('OnchainIngestor', () => {
  it('turns pump.fun logs into bus events and de-dupes creates', () => {
    const bus = new EventBus();
    const src = new FakeSource();
    const ing = new OnchainIngestor(src, {} as SolanaRpc, bus, silent, {
      programs: PROGRAM_IDS,
      venues: ['pumpfun'],
      emitTrades: true,
      poolTxFetchDelayMs: 0,
    });
    const seen: string[] = [];
    bus.on('token.created', () => seen.push('created'));
    bus.on('pumpfun.trade', () => seen.push('trade'));
    bus.on('pumpfun.complete', () => seen.push('complete'));
    bus.on('pumpfun.migrated', () => seen.push('migrated'));
    ing.start();
    const h = src.handlers.get(PROGRAM_IDS.pumpfun)!;
    const logs = logsFor(PROGRAM_IDS.pumpfun, [createEventData(), tradeEventData(), completeEventData(), migrationEventData()]);
    h({ signature: 's1', slot: 1, err: null, logs });
    h({ signature: 's1', slot: 1, err: null, logs }); // duplicate delivery
    expect(seen).toEqual(['created', 'trade', 'complete', 'migrated', 'trade']);
  });

  it('fetches the tx for pool creations and emits pool.created', async () => {
    const bus = new EventBus();
    const src = new FakeSource();
    const base = key(3);
    const rpc = {
      getTransaction: vi.fn(async () =>
        parsedTx({ signers: [key(1)], post: [tb(2, base, key(5), 10n), tb(3, WSOL_MINT, key(5), 10n)] }),
      ),
    } as unknown as SolanaRpc;
    const ing = new OnchainIngestor(src, rpc, bus, silent, {
      programs: PROGRAM_IDS,
      venues: ['raydium_cpmm'],
      emitTrades: false,
      poolTxFetchDelayMs: 0,
    });
    const pools: unknown[] = [];
    bus.on('pool.created', (p) => pools.push(p));
    ing.start();
    const id = PROGRAM_IDS.raydium_cpmm;
    await ing.handlePool({ signature: 'P1', slot: 1, err: null, logs: logsFor(id, [], ['Program log: Instruction: Initialize']) }, 'raydium_cpmm', id);
    await ing.handlePool({ signature: 'P2', slot: 1, err: null, logs: logsFor(id, [], ['Program log: Instruction: SwapBaseInput']) }, 'raydium_cpmm', id);
    expect(pools).toEqual([expect.objectContaining({ venue: 'raydium_cpmm', baseMint: base, quoteMint: WSOL_MINT })]);
    expect(ing.stats).toMatchObject({ poolCandidates: 1, poolsEmitted: 1 });
  });
});

describe('TokenRegistry', () => {
  const snap = (mint: string): MarketSnapshot => mapDexScreenerPair({ pairAddress: 'p', baseToken: { address: mint }, liquidity: { usd: 5 } })!;

  it('tracks tokens from every discovery path and evicts the least active when full', () => {
    let t = 0;
    const bus = new EventBus();
    const reg = new TokenRegistry(bus, { marketSnapshots: async () => new Map() }, silent, opts, () => t);
    bus.emit('token.discovered', { mint: 'a', source: 'x', ts: 0 });
    t = 1;
    bus.emit('social.mention', { source: 'reddit', id: '1', author: 'u', channel: 'c', text: '', mints: ['b'], tickers: [], isKol: false, ts: 1 });
    t = 2;
    bus.emit('wallet.trade', { wallet: 'w', mint: 'c', side: 'buy', tokenDelta: 1n, solDeltaLamports: -1n, signature: 's', slot: 1, ts: 2 });
    bus.emit('wallet.trade', { wallet: 'w', mint: 'z', side: 'sell', tokenDelta: -1n, solDeltaLamports: 1n, signature: 's', slot: 1, ts: 2 });
    t = 3;
    bus.emit('token.discovered', { mint: 'd', source: 'x', ts: 3 });
    expect([...reg.tokens.keys()].sort()).toEqual(['b', 'c', 'd']);
    expect(reg.prioritized().map((x) => x.mint)).toEqual(['d', 'c', 'b']);
  });

  it('refreshes market data only when due and emits snapshots', async () => {
    let t = 0;
    const bus = new EventBus();
    const calls: string[][] = [];
    const reg = new TokenRegistry(
      bus,
      { marketSnapshots: async (m) => (calls.push(m), new Map(m.map((x) => [x, snap(x)]))) },
      silent,
      opts,
      () => t,
    );
    const got: string[] = [];
    bus.on('market.snapshot', (s) => got.push(s.mint));
    reg.track('a', {});
    await reg.refreshMarket();
    await reg.refreshMarket(); // not due yet
    t = 10_000;
    await reg.refreshMarket();
    expect(calls).toEqual([['a'], ['a']]);
    expect(got).toEqual(['a', 'a']);
    expect(reg.tokens.get('a')!.market?.liquidityUsd).toBe(5);
  });

  it('derives curve state from trade events without RPC', () => {
    const bus = new EventBus();
    const reg = new TokenRegistry(bus, { marketSnapshots: async () => new Map() }, silent, opts);
    const curves: number[] = [];
    bus.on('pumpfun.curve', (c) => curves.push(c.progress));
    bus.emit('token.created', { mint: MINT, name: '', symbol: '', uri: '', bondingCurve: 'bc', creator: 'c', venue: 'pumpfun', signature: 's', slot: 1, ts: 0 });
    bus.emit('pumpfun.trade', {
      mint: MINT, user: 'u', isBuy: true, solAmount: 1n, tokenAmount: 1n,
      virtualSolReserves: 31_000_000_000n, virtualTokenReserves: 1_038_000_000_000_000n,
      realSolReserves: 1n, realTokenReserves: 396_550_000_000_000n, signature: 's', slot: 1, ts: 0,
    });
    expect(curves[0]).toBeCloseTo(0.5);
    expect(reg.tokens.get(MINT)!.onCurve).toBe(true);
  });

  it('expires inactive tokens', () => {
    let t = 0;
    const bus = new EventBus();
    const reg = new TokenRegistry(bus, { marketSnapshots: async () => new Map() }, silent, opts, () => t);
    reg.track('a', {});
    t = 61_000;
    reg.expire();
    expect(reg.tokens.size).toBe(0);
  });
});

describe('Recorder + Store', () => {
  it('persists events in batched transactions', () => {
    const bus = new EventBus();
    const store = new Store(':memory:');
    const reg = new TokenRegistry(bus, { marketSnapshots: async () => new Map() }, silent, opts);
    const rec = new Recorder(bus, store, reg, silent);
    bus.emit('token.created', { mint: MINT, name: 'N', symbol: 'S', uri: 'u', bondingCurve: 'bc', creator: 'c', venue: 'pumpfun', signature: 'sig', slot: 1, ts: 5 });
    bus.emit('pumpfun.trade', {
      mint: MINT, user: 'u', isBuy: true, solAmount: 10n, tokenAmount: 20n,
      virtualSolReserves: 1n, virtualTokenReserves: 1n, signature: 't', slot: 2, ts: 6,
    });
    bus.emit('pumpfun.trade', {
      mint: 'untracked', user: 'u', isBuy: true, solAmount: 1n, tokenAmount: 1n,
      virtualSolReserves: 1n, virtualTokenReserves: 1n, signature: 't2', slot: 2, ts: 6,
    });
    bus.emit('pumpfun.migrated', { mint: MINT, pool: 'pool1', signature: 'm', slot: 3, ts: 9 });
    bus.emit('market.snapshot', mapDexScreenerPair({ pairAddress: 'p', baseToken: { address: MINT }, priceUsd: '1.5' }, 7)!);
    bus.emit('social.mention', { source: 'x', id: '1', author: 'a', channel: 'x', text: 't', mints: [key(40)], tickers: [], isKol: true, ts: 8 });
    expect(store.count('tokens')).toBe(0); // queued, not yet flushed
    rec.flush();
    expect(store.count('tokens')).toBe(2);
    expect(store.count('pump_trades')).toBe(1);
    expect(store.count('market_snapshots')).toBe(1);
    expect(store.count('mentions')).toBe(1);
    expect(store.getToken(MINT)).toMatchObject({ symbol: 'S', venue: 'pumpfun', migrated_ms: 9, migrated_pool: 'pool1', created_ms: 5 });
    // prune removes old trades
    rec.prune(48 * 3600_000 + 7);
    expect(store.count('pump_trades')).toBe(0);
    store.close();
  });
});
