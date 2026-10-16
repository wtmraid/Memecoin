import { describe, expect, it, vi } from 'vitest';
import { extractMints, extractTickers, isSolanaAddress } from '../src/ingest/social/extract.js';
import { MentionTracker } from '../src/ingest/social/velocity.js';
import { mapRedditListing } from '../src/ingest/social/reddit.js';
import { mapTelegramMessage } from '../src/ingest/social/telegram.js';
import { kolQueries, ReadBudget, tweetToMention, XMentionSource, type XProvider } from '../src/ingest/social/x.js';
import type { SocialMention } from '../src/core/types.js';

const CA = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const PUMP_CA = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

describe('extract', () => {
  it('finds CAs in plain text and inside URLs', () => {
    const t = `aping ${CA} now!! chart https://dexscreener.com/solana/${PUMP_CA}`;
    expect(extractMints(t).sort()).toEqual([CA, PUMP_CA].sort());
  });
  it('ignores SOL/USDC mints, program ids and invalid base58', () => {
    const t = 'So11111111111111111111111111111111111111112 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P 0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl';
    expect(extractMints(t)).toEqual([]);
  });
  it('rejects base58 strings that are not 32 bytes', () => {
    expect(isSolanaAddress('1111111111111111111111111111111111111111111111')).toBe(false);
    expect(isSolanaAddress(CA)).toBe(true);
  });
  it('extracts cashtags, skips majors and dollar amounts', () => {
    expect(extractTickers('$WIF $bonk to the moon, $SOL $100 and US$5 a$b')).toEqual(['WIF', 'BONK']);
  });
});

const mention = (o: Partial<SocialMention>): SocialMention => ({
  source: 'x',
  id: Math.random().toString(),
  author: 'a',
  channel: 'x',
  text: '',
  mints: [CA],
  tickers: [],
  isKol: false,
  ts: 0,
  ...o,
});

describe('MentionTracker', () => {
  it('computes count, unique authors, KOLs and acceleration per window', () => {
    const t = new MentionTracker();
    const now = 10_000_000;
    // previous 5-min window: 2 mentions; current: 4 (3 authors, 1 KOL)
    t.record(mention({ ts: now - 400_000 }));
    t.record(mention({ ts: now - 350_000 }));
    t.record(mention({ ts: now - 100_000, author: 'a' }));
    t.record(mention({ ts: now - 90_000, author: 'b', isKol: true }));
    t.record(mention({ ts: now - 50_000, author: 'c', source: 'telegram' }));
    t.record(mention({ ts: now - 10_000, author: 'c', source: 'telegram' }));
    const v = t.velocity(`mint:${CA}`, 300, now);
    expect(v).toMatchObject({ count: 4, uniqueAuthors: 3, kolMentions: 1, acceleration: 2, bySource: { x: 2, telegram: 2 } });
    expect(v.perMin).toBeCloseTo(0.8);
  });
  it('acceleration is Infinity from zero, 0 when silent', () => {
    const t = new MentionTracker();
    t.record(mention({ ts: 1000 }));
    expect(t.velocity(`mint:${CA}`, 60, 2000).acceleration).toBe(Infinity);
    expect(t.velocity('mint:none', 60, 2000).acceleration).toBe(0);
  });
  it('prunes old hits', () => {
    const t = new MentionTracker(60);
    t.record(mention({ ts: 0 }));
    t.prune(120_000);
    expect(t.size).toBe(0);
  });
});

describe('Reddit', () => {
  it('maps listings, keeping only posts that name a token', () => {
    const out = mapRedditListing({
      data: {
        children: [
          { data: { name: 't3_a', author: 'u1', subreddit: 'solana', title: `New gem ${CA}`, selftext: '', permalink: '/r/solana/a', created_utc: 1_760_000_000 } },
          { data: { name: 't3_b', author: 'u2', subreddit: 'solana', title: 'How do I stake?', selftext: '' } },
          { data: { name: 't3_c', author: 'u3', subreddit: 'CryptoMoonShots', title: '$FROG launching', selftext: '' } },
        ],
      },
    });
    expect(out.map((m) => m.id)).toEqual(['t3_a', 't3_c']);
    expect(out[0]).toMatchObject({ source: 'reddit', channel: 'r/solana', mints: [CA], url: 'https://www.reddit.com/r/solana/a', ts: 1_760_000_000_000 });
    expect(out[1]!.tickers).toEqual(['FROG']);
  });
});

describe('Telegram', () => {
  it('maps messages and flags KOL channels case-insensitively', () => {
    const m = mapTelegramMessage({ id: 5, text: `CA: ${CA}`, chat: 'AlphaCalls', sender: 'bob', date: 100 }, new Set(['alphacalls']));
    expect(m).toMatchObject({ id: 'AlphaCalls:5', isKol: true, mints: [CA], ts: 100_000 });
    expect(mapTelegramMessage({ id: 6, text: 'gm', chat: 'x', sender: 'y', date: 1 }, new Set())).toBeNull();
  });
});

describe('X', () => {
  it('splits KOL handles into queries under the length limit', () => {
    const handles = Array.from({ length: 60 }, (_, i) => `kol_account_${i}`);
    const qs = kolQueries(handles, 200);
    expect(qs.length).toBeGreaterThan(1);
    for (const q of qs) expect(q.length).toBeLessThanOrEqual(200);
    expect(qs.join(' ').match(/from:/g)).toHaveLength(60);
  });

  it('ReadBudget resets at UTC midnight', () => {
    let now = Date.parse('2026-10-16T23:59:00Z');
    const b = new ReadBudget(100, () => now);
    b.consume(90);
    expect(b.remaining()).toBe(10);
    now = Date.parse('2026-10-17T00:00:01Z');
    expect(b.remaining()).toBe(100);
  });

  it('never calls the provider once the budget is exhausted, and tracks since_id', async () => {
    const search = vi.fn<XProvider['search']>(async () => ({
      tweets: [{ id: '10', text: `${CA}`, author: 'Kol1', createdAt: 1 }],
      newestId: '10',
    }));
    const budget = new ReadBudget(15);
    const src = new XMentionSource({ search }, budget, ['kol1']);
    const first = await src.pollKols();
    expect(first[0]).toMatchObject({ isKol: true, mints: [CA] });
    expect(search.mock.calls[0]![1]).toBe(15);
    await src.pollKols(); // remaining 14 ≥ 10 → allowed
    expect(search.mock.calls[1]![2]).toBe('10');
    budget.consume(100);
    await src.pollKols();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('tweetToMention drops tweets without token references', () => {
    expect(tweetToMention({ id: '1', text: 'gm', author: 'a', createdAt: 0 }, new Set())).toBeNull();
  });
});
