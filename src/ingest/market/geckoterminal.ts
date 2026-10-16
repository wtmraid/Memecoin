import type { HttpClient } from '../../core/http.js';
import type { MarketSnapshot, WindowStats } from '../../core/types.js';

/** Keyless base. Keyed CoinGecko plans use a different `/onchain` base — not used here. */
const BASE = 'https://api.geckoterminal.com/api/v2';

type Win = 'm5' | 'h1' | 'h6' | 'h24';
export interface GtPool {
  id?: string;
  attributes?: {
    address?: string;
    name?: string;
    pool_created_at?: string;
    base_token_price_usd?: string;
    base_token_price_native_currency?: string;
    reserve_in_usd?: string;
    fdv_usd?: string;
    market_cap_usd?: string | null;
    volume_usd?: Partial<Record<Win, string>>;
    price_change_percentage?: Partial<Record<Win, string>>;
    transactions?: Partial<Record<Win, { buys?: number; sells?: number; buyers?: number; sellers?: number }>>;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

const W: Win[] = ['m5', 'h1', 'h6', 'h24'];
const num = (v: unknown) => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const win = (f: (k: Win) => unknown): WindowStats =>
  Object.fromEntries(W.map((k) => [k, num(f(k)) ?? 0])) as unknown as WindowStats;

/** GeckoTerminal token ids look like `solana_<mint>`. */
export const gtMint = (id?: string) => (id?.startsWith('solana_') ? id.slice('solana_'.length) : null);

export function mapGeckoPool(p: GtPool, now = Date.now()): MarketSnapshot | null {
  const a = p.attributes;
  const mint = gtMint(p.relationships?.base_token?.data?.id);
  if (!a?.address || !mint) return null;
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
  return {
    mint,
    source: 'geckoterminal',
    pairAddress: a.address,
    dexId: p.relationships?.dex?.data?.id ?? 'unknown',
    priceUsd: num(a.base_token_price_usd),
    priceNative: num(a.base_token_price_native_currency),
    liquidityUsd: num(a.reserve_in_usd),
    fdvUsd: num(a.fdv_usd),
    marketCapUsd: num(a.market_cap_usd),
    volumeUsd: win((k) => a.volume_usd?.[k]),
    buys: win((k) => a.transactions?.[k]?.buys),
    sells: win((k) => a.transactions?.[k]?.sells),
    uniqueBuyers: win((k) => a.transactions?.[k]?.buyers),
    uniqueSellers: win((k) => a.transactions?.[k]?.sellers),
    priceChangePct: win((k) => a.price_change_percentage?.[k]),
    pairCreatedAt: Number.isFinite(created) ? created : null,
    websites: [],
    socials: [],
    ts: now,
  };
}

/** ~10 calls/min keyless — used for discovery only, polled slowly. */
export class GeckoTerminalClient {
  constructor(private http: HttpClient) {}

  private async pools(path: string): Promise<MarketSnapshot[]> {
    const r = await this.http.json<{ data?: GtPool[] }>(`${BASE}/${path}`, { label: `gecko:${path.split('?')[0]}` });
    return (r.data ?? []).map((p) => mapGeckoPool(p)).filter((s): s is MarketSnapshot => !!s);
  }

  newPools() {
    return this.pools('networks/solana/new_pools?page=1');
  }
  trendingPools() {
    return this.pools('networks/solana/trending_pools?page=1');
  }
}
