import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { analyzeClusters, buildClusters, FundingResolver, funderFromFirstTx, isPersonWallet, type FundingInfo } from '../src/safety/clusters.js';
import { findProgramAddress } from '../src/ingest/onchain/pda.js';
import { parsedTx } from './helpers.js';

/** A real ed25519 public key (on-curve) = a person's wallet. */
import { ed25519 } from '@noble/curves/ed25519';
const person = () => bs58.encode(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const info = (funder: string | null, txCount = 3, fullHistory = true): FundingInfo => ({ funder, txCount, fullHistory });

describe('funding source', () => {
  it('the funder is the account whose SOL went into the wallet', () => {
    const w = person();
    const f = person();
    const tx = parsedTx({ signers: [f], others: [w], preBalances: [5e9, 0], postBalances: [3.99e9, 1e9] });
    expect(funderFromFirstTx(tx, w)).toBe(f);
    expect(funderFromFirstTx(parsedTx({ signers: [f], others: [w], preBalances: [5e9, 0], postBalances: [5e9, 0] }), w)).toBeNull();
  });

  it('program-owned addresses (bonding curve, AMM vaults) are not treated as people', () => {
    const [pda] = findProgramAddress([Buffer.from('bonding-curve'), randomBytes(32)], '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    expect(isPersonWallet(pda)).toBe(false);
    expect(isPersonWallet(person())).toBe(true);
  });
});

describe('clustering (Bubblemaps-style)', () => {
  it('wallets sharing one funder form a cluster with their combined supply', () => {
    const [a, b, c, d, funder] = [person(), person(), person(), person(), person()];
    const m = new Map([[a, info(funder)], [b, info(funder)], [c, info(funder)], [d, info(person())]]);
    const r = buildClusters([{ owner: a, pct: 4 }, { owner: b, pct: 5 }, { owner: c, pct: 3 }, { owner: d, pct: 2 }], m, new Set(), null, null, 30);
    expect(r.largestClusterPct).toBe(12);
    expect(r.clusters[0]).toMatchObject({ owners: [a, b, c], via: funder, includesDev: false });
    expect(r.clusters).toHaveLength(1);
  });

  it('exchange hot wallets do not link unrelated buyers', () => {
    const [a, b, cex] = [person(), person(), person()];
    const m = new Map([[a, info(cex)], [b, info(cex)]]);
    expect(buildClusters([{ owner: a, pct: 6 }, { owner: b, pct: 6 }], m, new Set([cex]), null, null, 30).largestClusterPct).toBe(0);
  });

  it('holders funded by the dev (or the dev’s own funder) count as dev-linked', () => {
    const [dev, devFunder, x, y, z] = [person(), person(), person(), person(), person()];
    const m = new Map([[x, info(dev)], [y, info(devFunder)], [z, info(person())]]);
    const r = buildClusters([{ owner: x, pct: 3 }, { owner: y, pct: 4 }, { owner: z, pct: 2 }], m, new Set(), dev, devFunder, 30);
    expect(r.devLinkedPct).toBe(7);
    expect(r.clusters[0]!.includesDev).toBe(true);
  });

  it('chains: A funded B, B funded C → one cluster', () => {
    const [a, b, c] = [person(), person(), person()];
    const m = new Map([[a, info(person())], [b, info(a)], [c, info(b)]]);
    expect(buildClusters([{ owner: a, pct: 2 }, { owner: b, pct: 2 }, { owner: c, pct: 2 }], m, new Set(), null, null, 30).largestClusterPct).toBe(6);
  });

  it('fresh-wallet share counts only wallets whose whole history is short', () => {
    const [a, b, c, d] = [person(), person(), person(), person()];
    const m = new Map([[a, info(null, 3)], [b, info(null, 5)], [c, info(null, 500)], [d, info(null, 2000, false)]]);
    const r = buildClusters([a, b, c, d].map((o) => ({ owner: o, pct: 1 })), m, new Set(), null, null, 30);
    expect(r.freshHolderPct).toBe(50);
  });
});

describe('FundingResolver', () => {
  it('finds the first transaction, caches per wallet, and flags busy funders as hubs', async () => {
    const w = person();
    const f = person();
    const getSignatures = vi.fn(async (addr: string) => {
      if (addr === w) return [{ signature: 'newest', blockTime: 2 }, { signature: 'first', blockTime: 1 }];
      // funder: 1000 sigs within 1 hour → an exchange
      return Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, blockTime: 1_000_000 - i * 3 }));
    });
    const getTransaction = vi.fn(async (sig: string) =>
      sig === 'first' ? parsedTx({ signers: [f], others: [w], preBalances: [9e9, 0], postBalances: [8e9, 1e9] }) : null,
    );
    const r = new FundingResolver({ getSignatures, getTransaction });
    expect(await r.info(w)).toEqual({ funder: f, txCount: 2, fullHistory: true });
    await r.info(w);
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(await r.isHub(f)).toBe(true);
  });

  it('very active wallets are not fresh and have no funder link', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, blockTime: i }));
    const r = new FundingResolver({ getSignatures: async () => full, getTransaction: async () => null });
    expect(await r.info(person())).toEqual({ funder: null, txCount: 2000, fullHistory: false });
  });

  it('analyzeClusters skips program-owned holders and aggregates the report', async () => {
    const [a, b, funder] = [person(), person(), person()];
    const [curve] = findProgramAddress([Buffer.from('x')], '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const getSignatures = async (addr: string) => (addr === funder ? [{ signature: 'f1', blockTime: 1 }] : [{ signature: `first-${addr}`, blockTime: 1 }]);
    const getTransaction = async (sig: string) => {
      const owner = sig.replace('first-', '');
      return parsedTx({ signers: [funder], others: [owner], preBalances: [9e9, 0], postBalances: [8e9, 1e9] });
    };
    const r = await analyzeClusters(new FundingResolver({ getSignatures, getTransaction }), [{ owner: curve, pct: 70 }, { owner: a, pct: 8 }, { owner: b, pct: 9 }], null, { maxHolders: 15, freshMaxTx: 30 });
    expect(r.analyzed).toBe(2);
    expect(r.largestClusterPct).toBe(17);
  });
});
