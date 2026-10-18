import type { HttpClient } from '../../core/http.js';
import type { MarketSnapshot, WindowStats } from '../../core/types.js';

const BASE = 'https://api.dexscreener.com';
export const DEXSCREENER_MAX_ADDRESSES = 30;

/** Subset of the DexScreener pair object we consume. All fields treated as optional. */
export interface DsPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Partial<Record<keyof WindowStats, { buys?: number; sells?: number }>>;
  volume?: Partial<WindowStats>;
  priceChange?: Partial<WindowStats>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { websites?: { url?: string; label?: string }[]; socials?: { type?: string; url?: string }[] };
}

export interface DsProfile {
  chainId?: string;
  tokenAddress?: string;
  url?: string;
  totalAmount?: number;
  links?: { type?: string; label?: string; url?: string }[];
}

const W = ['m5', 'h1', 'h6', 'h24'] as const;
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const windows = (f: (k: (typeof W)[number]) => unknown): WindowStats =>
  Object.fromEntries(W.map((k) => [k, num(f(k)) ?? 0])) as unknown as WindowStats;

export function mapDexScreenerPair(p: DsPair, now = Date.now()): MarketSnapshot | null {
  const mint = p.baseToken?.address;
  if (!mint || !p.pairAddress) return null;
  return {
    mint,
    source: 'dexscreener',
    pairAddress: p.pairAddress,
    dexId: p.dexId ?? 'unknown',
    quoteMint: p.quoteToken?.address,
    symbol: p.baseToken?.symbol,
    name: p.baseToken?.name,
    priceUsd: num(p.priceUsd),
    priceNative: num(p.priceNative),
    liquidityUsd: num(p.liquidity?.usd),
    fdvUsd: num(p.fdv),
    marketCapUsd: num(p.marketCap),
    volumeUsd: windows((k) => p.volume?.[k]),
    buys: windows((k) => p.txns?.[k]?.buys),
    sells: windows((k) => p.txns?.[k]?.sells),
    priceChangePct: windows((k) => p.priceChange?.[k]),
    pairCreatedAt: num(p.pairCreatedAt),
    websites: (p.info?.websites ?? []).map((w) => w.url).filter((u): u is string => !!u),
    socials: (p.info?.socials ?? [])
      .filter((s) => s.url)
      .map((s) => ({ type: (s.type ?? 'unknown').toLowerCase(), url: s.url! })),
    ts: now,
  };
}

/**
 * Pick the pair that represents a token: highest USD liquidity among pairs where the
 * token is the base. Brand-new pairs often have no liquidity figure yet.
 */
export function primaryPairs(snaps: MarketSnapshot[]): Map<string, MarketSnapshot> {
  const best = new Map<string, MarketSnapshot>();
  for (const s of snaps) {
    const cur = best.get(s.mint);
    if (!cur || (s.liquidityUsd ?? -1) > (cur.liquidityUsd ?? -1)) best.set(s.mint, s);
  }
  return best;
}

export class DexScreenerClient {
  constructor(
    private http: HttpClient,
    private profileHttp: HttpClient = http,
  ) {}

  /** Batched lookup: ≤30 Solana mints per call. Returns one primary snapshot per mint. */
  async snapshots(mints: string[]): Promise<Map<string, MarketSnapshot>> {
    const out = new Map<string, MarketSnapshot>();
    for (let i = 0; i < mints.length; i += DEXSCREENER_MAX_ADDRESSES) {
      const chunk = mints.slice(i, i + DEXSCREENER_MAX_ADDRESSES);
      const pairs = await this.http.json<DsPair[]>(`${BASE}/tokens/v1/solana/${chunk.join(',')}`, {
        label: 'dexscreener:tokens',
      });
      const wanted = new Set(chunk);
      const snaps = (Array.isArray(pairs) ? pairs : [])
        .filter((p) => !p.chainId || p.chainId === 'solana')
        .map((p) => mapDexScreenerPair(p))
        .filter((s): s is MarketSnapshot => !!s && wanted.has(s.mint));
      for (const [k, v] of primaryPairs(snaps)) out.set(k, v);
    }
    return out;
  }

  /** Trending discovery feeds (lower rate limit — separate bucket). Solana mints only. */
  async trendingMints(): Promise<{ mint: string; source: string }[]> {
    const feeds = [
      ['token-profiles/latest/v1', 'ds:profiles'],
      ['token-boosts/latest/v1', 'ds:boosts'],
      ['token-boosts/top/v1', 'ds:boosts_top'],
    ] as const;
    const out: { mint: string; source: string }[] = [];
    for (const [path, source] of feeds) {
      const rows = await this.profileHttp.json<DsProfile[]>(`${BASE}/${path}`, { label: `dexscreener:${source}` });
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r.chainId === 'solana' && r.tokenAddress) out.push({ mint: r.tokenAddress, source });
      }
    }
    return out;
  }
}
