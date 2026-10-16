import { describe, expect, it } from 'vitest';
import { HttpClient, TokenBucket } from '../src/core/http.js';
import { DexScreenerClient, mapDexScreenerPair, primaryPairs, type DsPair } from '../src/ingest/market/dexscreener.js';
import { mapGeckoPool } from '../src/ingest/market/geckoterminal.js';
import { key } from './helpers.js';
import dsFixture from './fixtures/dexscreener-tokens.json' with { type: 'json' };
import gtFixture from './fixtures/gecko-new-pools.json' with { type: 'json' };

describe('DexScreener mapping', () => {
  it('maps a pair object (shape per community docs; strings → numbers)', () => {
    const s = mapDexScreenerPair(dsFixture[0] as DsPair, 1000)!;
    expect(s).toMatchObject({
      mint: dsFixture[0]!.baseToken.address,
      source: 'dexscreener',
      dexId: 'pumpswap',
      priceUsd: 0.000123,
      liquidityUsd: 45210.5,
      buys: { m5: 40, h1: 310, h6: 900, h24: 900 },
      sells: { m5: 12, h1: 150, h6: 400, h24: 400 },
      pairCreatedAt: 1760000000000,
    });
    expect(s.socials).toEqual([{ type: 'twitter', url: 'https://x.com/example' }]);
    expect(s.websites).toEqual(['https://example.com']);
  });

  it('missing optional fields become null/0 instead of NaN', () => {
    const s = mapDexScreenerPair({ pairAddress: 'p', baseToken: { address: 'm' } })!;
    expect(s.priceUsd).toBeNull();
    expect(s.volumeUsd).toEqual({ m5: 0, h1: 0, h6: 0, h24: 0 });
    expect(s.socials).toEqual([]);
  });

  it('picks the most liquid pair per mint', () => {
    const snaps = (dsFixture as DsPair[]).map((p) => mapDexScreenerPair(p)!);
    const best = primaryPairs(snaps).get(dsFixture[0]!.baseToken.address)!;
    expect(best.liquidityUsd).toBe(45210.5);
  });

  it('batches lookups 30 mints per call and filters foreign mints', async () => {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(dsFixture), { status: 200 });
    };
    const ds = new DexScreenerClient(new HttpClient(new TokenBucket(1000, 1000), fetchImpl));
    const mints = Array.from({ length: 65 }, (_, i) => key(i + 30));
    mints[0] = dsFixture[0]!.baseToken.address;
    const out = await ds.snapshots(mints);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('/tokens/v1/solana/');
    expect(urls[0]!.split('/').pop()!.split(',')).toHaveLength(30);
    expect([...out.keys()]).toEqual([dsFixture[0]!.baseToken.address]);
  });
});

describe('GeckoTerminal mapping', () => {
  it('maps JSON:API pools including unique buyers/sellers', () => {
    const s = mapGeckoPool(gtFixture.data[0]!)!;
    expect(s).toMatchObject({
      source: 'geckoterminal',
      mint: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      dexId: 'pump-fun',
      liquidityUsd: 8123.45,
      uniqueBuyers: { m5: 25, h1: 80, h6: 80, h24: 80 },
      pairCreatedAt: Date.parse('2026-10-16T03:00:00Z'),
    });
  });
  it('drops pools whose base token is not on solana', () => {
    expect(mapGeckoPool({ attributes: { address: 'x' }, relationships: { base_token: { data: { id: 'eth_0xabc' } } } })).toBeNull();
  });
});
