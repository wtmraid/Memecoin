import { describe, expect, it } from 'vitest';
import { HttpClient, TokenBucket } from '../src/core/http.js';
import { GmgnClient, gmgnUrl, mapGmgn } from '../src/safety/gmgn.js';
import { evaluateRoundTrip, JupiterSellSim } from '../src/safety/jupiter.js';
import { parseMintAccount, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../src/safety/mintInfo.js';
import { mapRugcheck } from '../src/safety/rugcheck.js';
import { checkSocials, SocialIndex } from '../src/safety/socials.js';
import info from './fixtures/gmgn-info.json' with { type: 'json' };
import sec from './fixtures/gmgn-security.json' with { type: 'json' };

const fast = () => new TokenBucket(1000, 1000);

describe('GMGN mapping (values from the screenshot)', () => {
  const g = mapGmgn('MINT', info, sec);
  it('maps every Core Metrics tile to %', () => {
    expect(g).toMatchObject({
      taxPct: 1.25,
      top10Pct: 21.16,
      bundlerPct: 31.75,
      phishingPct: 2.03,
      insiderPct: 0,
      sniperCount: 0,
      devHoldPct: 0,
      devMigrated: 48,
      rugRatio: 0.02,
    });
  });
  it('maps safety flags, lifecycle and wallets', () => {
    expect(g).toMatchObject({
      mintRenounced: true,
      freezeRenounced: true,
      lpBurned: false,
      creatorStatus: 'closed',
      launchpadStatus: 'curve',
      launchpadProgress: 0.83,
      smartWallets: 3,
      renownedWallets: 1,
      holderCount: 412,
      symbol: 'Hilton',
    });
    expect(g.socials.twitter).toBe('https://x.com/ParisHilton');
    expect(g.socials.telegram).toBeUndefined();
  });
  it('missing payloads give nulls, never NaN, and a GMGN link built from the mint', () => {
    const e = mapGmgn('So1MintXYZ', null, null);
    expect(e.top10Pct).toBeNull();
    expect(e.mintRenounced).toBeNull();
    expect(e.gmgnLink).toBe('https://gmgn.ai/sol/token/So1MintXYZ');
  });
  it('gmgnUrl points to the exact token page', () => {
    expect(gmgnUrl('ABCpump')).toBe('https://gmgn.ai/sol/token/ABCpump');
  });
});

describe('GmgnClient', () => {
  it('sends X-APIKEY, timestamp and a fresh client_id', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const http = new HttpClient(fast(), async (url, init) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ code: 0, data: url.includes('security') ? sec : info }), { status: 200 });
    });
    const f = await new GmgnClient(http, 'k123').facts('MINT');
    expect(f.bundlerPct).toBe(31.75);
    expect(seen).toHaveLength(2);
    const u = new URL(seen[0]!.url);
    expect(u.origin).toBe('https://openapi.gmgn.ai');
    expect(u.searchParams.get('chain')).toBe('sol');
    expect(u.searchParams.get('address')).toBe('MINT');
    expect(Number(u.searchParams.get('timestamp'))).toBeGreaterThan(1e9);
    expect(u.searchParams.get('client_id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(new URL(seen[1]!.url).searchParams.get('client_id')).not.toBe(u.searchParams.get('client_id'));
    expect(seen[0]!.headers['X-APIKEY']).toBe('k123');
  });

  it('on 429 stops calling until reset_at instead of extending the ban', async () => {
    let calls = 0;
    const resetAt = Math.floor(Date.now() / 1000) + 300;
    const http = new HttpClient(fast(), async () => {
      calls++;
      return new Response(JSON.stringify({ code: 429, error: 'RATE_LIMIT_BANNED', reset_at: resetAt }), { status: 429 });
    });
    const g = new GmgnClient(http, 'k');
    await expect(g.info('A')).rejects.toThrow(/RATE_LIMITED/);
    await expect(g.info('A')).rejects.toThrow(/cooling down/);
    expect(calls).toBe(1);
  });

  it('API-level errors (code ≠ 0) throw', async () => {
    const http = new HttpClient(fast(), async () => new Response(JSON.stringify({ code: 40001, error: 'BAD', message: 'nope' }), { status: 200 }));
    await expect(new GmgnClient(http, 'k').info('A')).rejects.toThrow(/BAD/);
  });

  it('dev history: launches and graduation rate', async () => {
    const http = new HttpClient(fast(), async () =>
      new Response(JSON.stringify({ code: 0, data: { inner_count: 90, open_count: 10, tokens: [] } }), { status: 200 }),
    );
    expect(await new GmgnClient(http, 'k').devHistory('dev')).toEqual({ launches: 100, migrated: 10, gradRate: 0.1 });
  });
});

describe('mint account', () => {
  it('classic SPL with revoked authorities is clean', () => {
    const m = parseMintAccount({ owner: TOKEN_PROGRAM, data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, decimals: 6, supply: '1000' } } } });
    expect(m).toMatchObject({ mintAuthority: null, freezeAuthority: null, isToken2022: false, dangerous: [], transferFeeBps: 0 });
  });
  it('flags dangerous Token-2022 extensions and reads the transfer fee', () => {
    const m = parseMintAccount({
      owner: TOKEN_2022_PROGRAM,
      data: {
        parsed: {
          info: {
            mintAuthority: 'X',
            freezeAuthority: null,
            decimals: 6,
            supply: '1',
            extensions: [
              { extension: 'metadataPointer', state: {} },
              { extension: 'permanentDelegate', state: { delegate: 'D' } },
              { extension: 'defaultAccountState', state: { accountState: 'frozen' } },
              { extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 500 } } },
            ],
          },
        },
      },
    });
    expect(m.isToken2022).toBe(true);
    expect(m.dangerous).toEqual(['permanentDelegate', 'defaultAccountState:frozen']);
    expect(m.transferFeeBps).toBe(500);
  });
});

describe('Jupiter sell simulation', () => {
  it('round-trip loss math', () => {
    expect(evaluateRoundTrip(1_000_000_000n, 960_000_000n, '0.012')).toEqual({ routable: true, roundTripLossPct: 4, sellPriceImpactPct: 1.2 });
    expect(evaluateRoundTrip(1n, 0n).routable).toBe(false);
  });
  it('buys then sells exactly the tokens the buy returns', async () => {
    const urls: URL[] = [];
    const http = new HttpClient(fast(), async (u) => {
      const url = new URL(u);
      urls.push(url);
      const selling = url.searchParams.get('outputMint')!.startsWith('So111');
      return new Response(JSON.stringify({ outAmount: selling ? '450000000' : '123456', priceImpactPct: '0.01' }), { status: 200 });
    });
    const r = await new JupiterSellSim(http, 'jk').simulate('TOKEN', 0.5);
    expect(urls[0]!.host).toBe('api.jup.ag');
    expect(urls[0]!.searchParams.get('amount')).toBe('500000000');
    expect(urls[1]!.searchParams.get('amount')).toBe('123456');
    expect(r).toMatchObject({ routable: true, roundTripLossPct: 10 });
  });
  it('no sell route = not routable (possible honeypot)', async () => {
    let n = 0;
    const http = new HttpClient(fast(), async () =>
      n++ === 0 ? new Response(JSON.stringify({ outAmount: '5' }), { status: 200 }) : new Response('{"error":"No routes found"}', { status: 400 }),
    );
    const r = await new JupiterSellSim(http).simulate('T', 0.5);
    expect(r.routable).toBe(false);
    expect(r.error).toMatch(/No routes/);
  });
});

describe('Jupiter outage', () => {
  it('network errors / 5xx are not reported as a honeypot (they throw → unknown)', async () => {
    const http = new HttpClient(fast(), async () => new Response('down', { status: 503 }), 1);
    await expect(new JupiterSellSim(http).simulate('T', 0.5)).rejects.toThrow(/503/);
  });
});

describe('RugCheck', () => {
  it('splits dangers from warnings and sanitises names', () => {
    expect(
      mapRugcheck({ score_normalised: 40, lpLockedPct: 99.5, risks: [{ name: 'Mutable <b>metadata</b>', level: 'warn' }, { name: 'Freeze Authority', level: 'danger' }] }),
    ).toEqual({ scoreNormalised: 40, dangers: ['Freeze Authority'], warnings: ['Mutable bmetadata/b'], lpLockedPct: 99.5 });
  });
});

describe('socials', () => {
  it('accepts a real project profile', () => {
    expect(checkSocials({ twitter: 'https://x.com/MyCoin', website: 'https://mycoin.fun', telegram: 'https://t.me/mycoin' })).toEqual({
      hasAny: true,
      keys: ['x:mycoin', 'web:mycoin.fun', 'tg:mycoin'],
      problems: [],
    });
  });
  it('flags borrowed tweets/communities, shorteners and junk', () => {
    expect(checkSocials({ twitter: 'https://x.com/elonmusk/status/123' }).problems[0]).toMatch(/tweet/);
    expect(checkSocials({ twitter: 'https://x.com/i/communities/1' }).problems[0]).toMatch(/community/);
    expect(checkSocials({ website: 'https://bit.ly/abc' }).problems[0]).toMatch(/shortener/);
    expect(checkSocials({ telegram: 'https://example.com/x' }).problems[0]).toMatch(/t\.me/);
    expect(checkSocials({}).hasAny).toBe(false);
  });
  it('SocialIndex finds the same account reused by another token within 7 days', () => {
    const idx = new SocialIndex();
    expect(idx.record('A', ['x:scam'], 0)).toEqual([]);
    expect(idx.record('A', ['x:scam'], 1000)).toEqual([]);
    expect(idx.record('B', ['x:scam'], 2000)).toEqual(['A']);
    expect(idx.record('C', ['x:scam'], 8 * 86_400_000)).toEqual([]);
  });
});

import { ipfsToHttps, socialsFromMetadata } from '../src/safety/metadata.js';

describe('token metadata socials (pump.fun)', () => {
  it('reads twitter/telegram/website from the metadata JSON, normalising handles', () => {
    expect(socialsFromMetadata({ name: 'X', twitter: 'https://x.com/realcoin', telegram: '@realcoinchat', website: 'https://real.fun' })).toEqual({
      twitter: 'https://x.com/realcoin',
      telegram: 'https://t.me/realcoinchat',
      website: 'https://real.fun',
    });
    expect(socialsFromMetadata({ extensions: { twitter: 'realcoin' } })).toEqual({ twitter: 'https://x.com/realcoin' });
    expect(socialsFromMetadata({ twitter: 42, telegram: '' })).toEqual({});
    expect(socialsFromMetadata('junk')).toEqual({});
  });
  it('maps ipfs:// and arweave URIs to https and refuses others', () => {
    expect(ipfsToHttps('ipfs://Qm123')).toBe('https://ipfs.io/ipfs/Qm123');
    expect(ipfsToHttps('https://ipfs.io/ipfs/Qm123')).toBe('https://ipfs.io/ipfs/Qm123');
    expect(ipfsToHttps('ar://abc')).toBe('https://arweave.net/abc');
    expect(ipfsToHttps('http://insecure/x')).toBeNull();
    expect(ipfsToHttps('file:///etc/passwd')).toBeNull();
  });
});
