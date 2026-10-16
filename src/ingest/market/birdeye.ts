import type { HttpClient } from '../../core/http.js';

const BASE = 'https://public-api.birdeye.so';

/**
 * Optional enrichment (needs BIRDEYE_API_KEY). Free "Standard" plan is 1 rps with
 * limited data access, so this is only a holder-count fallback when DAS is unavailable.
 * Field names per Birdeye token_overview docs — verify with `npm run smoke`.
 */
export class BirdeyeClient {
  constructor(
    private http: HttpClient,
    private apiKey: string,
  ) {}

  async overview(mint: string): Promise<{ holders: number | null; liquidityUsd: number | null; priceUsd: number | null }> {
    const r = await this.http.json<{ success?: boolean; data?: { holder?: number; liquidity?: number; price?: number } }>(
      `${BASE}/defi/token_overview?address=${encodeURIComponent(mint)}`,
      { headers: { 'X-API-KEY': this.apiKey, 'x-chain': 'solana' }, label: 'birdeye:overview' },
    );
    const d = r.data ?? {};
    return {
      holders: typeof d.holder === 'number' ? d.holder : null,
      liquidityUsd: typeof d.liquidity === 'number' ? d.liquidity : null,
      priceUsd: typeof d.price === 'number' ? d.price : null,
    };
  }
}
