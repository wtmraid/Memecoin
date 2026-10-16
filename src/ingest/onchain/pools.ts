import { programLogged } from './logs.js';
import { POOL_CREATE_MARKERS, QUOTE_MINTS, WSOL_MINT } from './programs.js';
import type { LogNotification, PoolCreated, Venue } from '../../core/types.js';
import type { ParsedTx } from './rpc.js';

export type PoolVenue = Exclude<Venue, 'pumpfun'>;

/** Cheap first pass on a logs notification: did `venue`'s program create a pool here? */
export function isPoolCreation(n: LogNotification, venue: PoolVenue, programId: string): boolean {
  if (n.err) return false;
  return programLogged(n.logs, programId, POOL_CREATE_MARKERS[venue]);
}

/**
 * Work out the traded pair from a pool-creation transaction, DEX-agnostically.
 *
 * Every AMM / launchpad we watch holds the two reserves in vault token accounts that
 * share one non-signer owner (pool PDA or pool authority). LP / position tokens go
 * to the signer, so grouping post-token-balances by non-signer owner and picking the
 * owner that holds exactly two mints gives the pair without per-program account
 * layouts. Fallback: the single non-quote mint paired with a quote mint.
 */
export function extractPairFromTx(tx: ParsedTx): { baseMint: string; quoteMint: string; vaultOwner?: string } | null {
  const balances = tx.meta?.postTokenBalances ?? [];
  if (!balances.length) return null;
  const signers = new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey));

  const byOwner = new Map<string, Set<string>>();
  for (const b of balances) {
    if (!b.owner || signers.has(b.owner)) continue;
    if (!byOwner.has(b.owner)) byOwner.set(b.owner, new Set());
    byOwner.get(b.owner)!.add(b.mint);
  }
  const pairs = [...byOwner.entries()].filter(([, m]) => m.size === 2);
  // Prefer a vault pair that includes a quote asset.
  const best = pairs.find(([, m]) => [...m].some((x) => QUOTE_MINTS.has(x))) ?? pairs[0];
  if (best) {
    const [owner, mints] = best;
    return { ...orient([...mints]), vaultOwner: owner };
  }

  const mints = [...new Set(balances.map((b) => b.mint))];
  const nonQuote = mints.filter((m) => !QUOTE_MINTS.has(m));
  const quote = mints.find((m) => QUOTE_MINTS.has(m));
  if (nonQuote.length === 1 && quote) return { baseMint: nonQuote[0]!, quoteMint: quote };
  return null;
}

function orient(m: string[]): { baseMint: string; quoteMint: string } {
  const [a, b] = m as [string, string];
  if (QUOTE_MINTS.has(a) && !QUOTE_MINTS.has(b)) return { baseMint: b, quoteMint: a };
  if (QUOTE_MINTS.has(b) && !QUOTE_MINTS.has(a)) return { baseMint: a, quoteMint: b };
  // Both quote (e.g. SOL/USDC) or neither: SOL is the quote if present, else keep order.
  if (a === WSOL_MINT) return { baseMint: b, quoteMint: a };
  return { baseMint: a, quoteMint: b };
}

export function buildPoolCreated(
  venue: PoolVenue,
  n: LogNotification,
  tx: ParsedTx,
  now = Date.now(),
): PoolCreated | null {
  const pair = extractPairFromTx(tx);
  if (!pair) return null;
  return {
    venue,
    signature: n.signature,
    slot: tx.slot || n.slot,
    baseMint: pair.baseMint,
    quoteMint: pair.quoteMint,
    pool: pair.vaultOwner,
    ts: tx.blockTime ? tx.blockTime * 1000 : now,
  };
}
