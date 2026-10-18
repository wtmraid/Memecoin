import bs58 from 'bs58';
import { isOnCurve } from '../ingest/onchain/pda.js';
import type { ParsedTx } from '../ingest/onchain/rpc.js';

/**
 * Bubblemaps-style connected-wallet detection, built from public chain data only.
 *
 * Bubblemaps shows top holders as bubbles and draws links between wallets that funded
 * each other. One person splitting a big bag over 10 fresh wallets looks "decentralised"
 * on a holder list but shows up as one cluster here. We do the same with two read-only
 * lookups per wallet: its oldest transaction (→ who sent it its first SOL) and its
 * transaction count (→ fresh wallet or not). Results are cached per wallet forever, so
 * the cost drops as the bot runs.
 */

export interface HolderIn {
  owner: string;
  /** % of supply. */
  pct: number;
}

export interface FundingInfo {
  /** Who sent this wallet its first SOL. null = unknown (old/very busy wallet or no SOL in). */
  funder: string | null;
  /** Transactions seen (capped by the page limit). */
  txCount: number;
  /** Reached the wallet's first-ever transaction (i.e. the wallet is young / low activity). */
  fullHistory: boolean;
}

export interface Cluster {
  owners: string[];
  pct: number;
  includesDev: boolean;
  /** The shared funding wallet, when the link is a common funder. */
  via?: string;
}

export interface ClusterReport {
  analyzed: number;
  /** Largest group of top holders controlled by one funder (% of supply). */
  largestClusterPct: number;
  clusters: Cluster[];
  /** % of supply in top holders linked to the token creator (funded by / funding the dev or the dev's funder). */
  devLinkedPct: number;
  /** % of analysed top holders (by count) that are fresh wallets. */
  freshHolderPct: number;
}

export interface ClusterDeps {
  getSignatures(address: string, before?: string): Promise<{ signature: string; blockTime: number | null }[]>;
  getTransaction(signature: string): Promise<ParsedTx | null>;
}

const PAGE = 1000;

/** Pure: from a wallet's first transaction, the account that paid SOL into it. */
export function funderFromFirstTx(tx: ParsedTx, wallet: string): string | null {
  const meta = tx.meta;
  if (!meta) return null;
  const keys = tx.transaction.message.accountKeys;
  const wi = keys.findIndex((k) => k.pubkey === wallet);
  if (wi < 0) return null;
  const delta = (i: number) => (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
  if (delta(wi) <= 0) return null;
  let best: { key: string; d: number } | null = null;
  keys.forEach((k, i) => {
    if (i === wi) return;
    const d = delta(i);
    if (d < 0 && (!best || d < best.d)) best = { key: k.pubkey, d };
  });
  return (best as { key: string; d: number } | null)?.key ?? null;
}

export class FundingResolver {
  private funding = new Map<string, Promise<FundingInfo>>();
  private hubs = new Map<string, Promise<boolean>>();

  constructor(
    private deps: ClusterDeps,
    private opts: { maxPages: number; freshMaxTx: number; hubMinTxPerDay: number } = { maxPages: 2, freshMaxTx: 30, hubMinTxPerDay: 1000 },
  ) {}

  info(wallet: string): Promise<FundingInfo> {
    let p = this.funding.get(wallet);
    if (!p) {
      p = this.load(wallet).catch(() => ({ funder: null, txCount: 0, fullHistory: false }));
      this.funding.set(wallet, p);
      if (this.funding.size > 50_000) this.funding.delete(this.funding.keys().next().value as string);
    }
    return p;
  }

  private async load(wallet: string): Promise<FundingInfo> {
    let before: string | undefined;
    let total = 0;
    let oldest: string | undefined;
    for (let page = 0; page < this.opts.maxPages; page++) {
      const sigs = await this.deps.getSignatures(wallet, before);
      total += sigs.length;
      if (sigs.length) oldest = sigs[sigs.length - 1]!.signature;
      if (sigs.length < PAGE) {
        if (!oldest) return { funder: null, txCount: 0, fullHistory: true };
        const tx = await this.deps.getTransaction(oldest);
        return { funder: tx ? funderFromFirstTx(tx, wallet) : null, txCount: total, fullHistory: true };
      }
      before = oldest;
    }
    // Very active wallet — not a fresh sybil; its funder is irrelevant.
    return { funder: null, txCount: total, fullHistory: false };
  }

  /**
   * Exchanges and payment services fund thousands of unrelated people. Linking wallets
   * through them would make every token look clustered, so very busy funders are hubs.
   */
  isHub(address: string): Promise<boolean> {
    let p = this.hubs.get(address);
    if (!p) {
      p = this.deps
        .getSignatures(address)
        .then((sigs) => {
          if (sigs.length < PAGE) return false;
          const newest = sigs[0]?.blockTime ?? 0;
          const oldest = sigs[sigs.length - 1]?.blockTime ?? 0;
          const days = Math.max((newest - oldest) / 86_400, 1 / 24);
          return sigs.length / days >= this.opts.hubMinTxPerDay;
        })
        .catch(() => true); // unknown → don't link through it (avoid false clusters)
      this.hubs.set(address, p);
    }
    return p;
  }

  get cached() {
    return this.funding.size;
  }
}

/** Program-owned addresses (bonding curve, AMM vaults, lockers) are not people. */
export function isPersonWallet(address: string): boolean {
  try {
    const b = bs58.decode(address);
    return b.length === 32 && isOnCurve(b);
  } catch {
    return false;
  }
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Pure clustering given funding info. Links: holder ↔ its funder (unless the funder is a
 * hub), which joins holders that share a funder, holders that funded each other, and
 * anyone connected to the creator.
 */
export function buildClusters(
  holders: HolderIn[],
  info: Map<string, FundingInfo>,
  hubs: Set<string>,
  creator: string | null,
  creatorFunder: string | null,
  freshMaxTx: number,
): ClusterReport {
  const uf = new UnionFind();
  const link = (a: string, b: string | null) => {
    if (b && !hubs.has(b)) uf.union(a, b);
  };
  for (const h of holders) {
    uf.find(h.owner);
    link(h.owner, info.get(h.owner)?.funder ?? null);
  }
  if (creator) {
    uf.find(creator);
    link(creator, creatorFunder);
  }
  const groups = new Map<string, HolderIn[]>();
  for (const h of holders) {
    const r = uf.find(h.owner);
    groups.set(r, [...(groups.get(r) ?? []), h]);
  }
  const devRoot = creator ? uf.find(creator) : null;
  const clusters: Cluster[] = [];
  let devLinkedPct = 0;
  for (const [root, hs] of groups) {
    const includesDev = root === devRoot;
    const pct = hs.reduce((a, h) => a + h.pct, 0);
    if (includesDev) devLinkedPct += hs.filter((h) => h.owner !== creator).reduce((a, h) => a + h.pct, 0);
    if (hs.length >= 2 || (includesDev && hs.some((h) => h.owner !== creator))) {
      const funders = new Set(hs.map((h) => info.get(h.owner)?.funder).filter(Boolean));
      clusters.push({ owners: hs.map((h) => h.owner), pct: round(pct), includesDev, via: funders.size === 1 ? [...funders][0]! : undefined });
    }
  }
  clusters.sort((a, b) => b.pct - a.pct);
  const fresh = holders.filter((h) => {
    const i = info.get(h.owner);
    return i?.fullHistory && i.txCount <= freshMaxTx;
  }).length;
  return {
    analyzed: holders.length,
    largestClusterPct: clusters[0]?.pct ?? 0,
    clusters,
    devLinkedPct: round(devLinkedPct),
    freshHolderPct: holders.length ? round((fresh / holders.length) * 100) : 0,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Resolve funding for the top holders (+ creator) and cluster them. */
export async function analyzeClusters(
  resolver: FundingResolver,
  holders: HolderIn[],
  creator: string | null,
  opts: { maxHolders: number; freshMaxTx: number },
): Promise<ClusterReport> {
  const people = holders.filter((h) => isPersonWallet(h.owner)).sort((a, b) => b.pct - a.pct).slice(0, opts.maxHolders);
  const info = new Map<string, FundingInfo>();
  await Promise.all(people.map(async (h) => info.set(h.owner, await resolver.info(h.owner))));
  const creatorInfo = creator ? await resolver.info(creator) : null;
  const funders = new Set<string>([...info.values(), ...(creatorInfo ? [creatorInfo] : [])].map((i) => i.funder).filter((f): f is string => !!f));
  const hubs = new Set<string>();
  await Promise.all([...funders].map(async (f) => (await resolver.isHub(f)) && hubs.add(f)));
  return buildClusters(people, info, hubs, creator, creatorInfo?.funder ?? null, opts.freshMaxTx);
}

/** Wire the analyzer to a Solana RPC: top holders → owners → funding → clusters. */
export function makeClusterAnalyzer(
  rpc: import('../ingest/onchain/rpc.js').SolanaRpc,
  fetchHolders: (mint: string) => Promise<{ top: { owner?: string; pct: number }[] }>,
  opts: { maxHolders: number; freshMaxTx: number; hubMinTxPerDay: number },
) {
  const resolver = new FundingResolver(
    { getSignatures: (a, before) => rpc.getSignaturesForAddress(a, { before }), getTransaction: (s) => rpc.getTransaction(s) },
    { maxPages: 2, freshMaxTx: opts.freshMaxTx, hubMinTxPerDay: opts.hubMinTxPerDay },
  );
  return async (mint: string, creator: string | null): Promise<ClusterReport | null> => {
    const h = await fetchHolders(mint);
    const byOwner = new Map<string, number>();
    for (const t of h.top) if (t.owner) byOwner.set(t.owner, (byOwner.get(t.owner) ?? 0) + t.pct);
    const holders = [...byOwner].map(([owner, pct]) => ({ owner, pct }));
    if (!holders.length) return null;
    return analyzeClusters(resolver, holders, creator, opts);
  };
}
