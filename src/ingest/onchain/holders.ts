import type { HolderStats } from '../../core/types.js';
import type { SolanaRpc } from './rpc.js';

export interface HolderOptions {
  /** DAS pages of 1000 accounts to scan for the holder count; result is a lower bound past this. */
  maxPages: number;
  useDas: boolean;
}

/** Pure: % of supply for each top account. */
export function topHolderPct(
  top: { address: string; owner?: string; amount: bigint }[],
  supply: bigint,
): HolderStats['top'] {
  return top.map((t) => ({
    ...t,
    pct: supply > 0n ? Number((t.amount * 1_000_000n) / supply) / 10_000 : 0,
  }));
}

/**
 * Top-20 accounts via getTokenLargestAccounts (+ owners, so Phase 2 can exclude the
 * LP vault and bonding curve), holder count via Helius DAS pagination.
 */
export async function fetchHolderStats(rpc: SolanaRpc, mint: string, opts: HolderOptions): Promise<HolderStats> {
  const [supply, largest] = await Promise.all([rpc.getTokenSupply(mint), rpc.getTokenLargestAccounts(mint)]);
  const owners = await rpc.getTokenAccountOwners(largest.map((l) => l.address));
  const top = topHolderPct(
    largest.map((l) => ({ ...l, owner: owners.get(l.address) })),
    supply.amount,
  );

  let holderCount: number | null = null;
  let lowerBound = false;
  if (opts.useDas) {
    const owners = new Set<string>();
    for (let page = 1; page <= opts.maxPages; page++) {
      const r = await rpc.dasTokenAccounts(mint, page);
      for (const a of r.token_accounts) if (a.amount > 0) owners.add(a.owner);
      if (r.token_accounts.length < 1000) break;
      if (page === opts.maxPages) lowerBound = true;
    }
    holderCount = owners.size;
  }
  return {
    mint,
    supply: supply.amount,
    decimals: supply.decimals,
    top,
    holderCount,
    holderCountIsLowerBound: lowerBound,
    ts: Date.now(),
  };
}
