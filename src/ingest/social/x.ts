import type { HttpClient } from '../../core/http.js';
import type { SocialMention } from '../../core/types.js';
import { extractMints, extractTickers } from './extract.js';

/**
 * Hard daily read budget. X pay-per-use bills per post read ($0.005 each as of
 * 2026-10), so every provider must reserve reads before calling.
 */
export class ReadBudget {
  private day = '';
  private used = 0;
  constructor(
    private maxPerDay: number,
    private now: () => number = Date.now,
  ) {}
  private roll() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
  }
  remaining() {
    this.roll();
    return Math.max(0, this.maxPerDay - this.used);
  }
  consume(n: number) {
    this.roll();
    this.used += n;
  }
}

export interface Tweet {
  id: string;
  text: string;
  author: string;
  createdAt: number;
}

export function tweetToMention(t: Tweet, kols: Set<string>): SocialMention | null {
  const mints = extractMints(t.text);
  const tickers = extractTickers(t.text);
  if (!mints.length && !tickers.length) return null;
  return {
    source: 'x',
    id: t.id,
    author: t.author,
    channel: 'x',
    text: t.text.slice(0, 2000),
    url: `https://x.com/${t.author}/status/${t.id}`,
    mints,
    tickers,
    isKol: kols.has(t.author.toLowerCase()),
    ts: t.createdAt,
  };
}

/** Build `(from:a OR from:b …) -is:retweet` queries under a max length. */
export function kolQueries(handles: string[], maxLen = 512): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const render = (hs: string[]) => `(${hs.map((h) => `from:${h}`).join(' OR ')}) -is:retweet`;
  for (const h of handles) {
    const next = [...cur, h];
    if (cur.length && render(next).length > maxLen) {
      out.push(render(cur));
      cur = [h];
    } else cur = next;
  }
  if (cur.length) out.push(render(cur));
  return out;
}

export interface XProvider {
  /** Returns tweets newer than `sinceId` (if supported), reading at most `maxReads`. */
  search(query: string, maxReads: number, sinceId?: string): Promise<{ tweets: Tweet[]; newestId?: string }>;
}

/** Official X API v2 recent search (pay-per-use). */
export class OfficialXProvider implements XProvider {
  constructor(
    private http: HttpClient,
    private bearer: string,
  ) {}
  async search(query: string, maxReads: number, sinceId?: string) {
    const n = Math.max(10, Math.min(100, maxReads));
    const qs = new URLSearchParams({
      query,
      max_results: String(n),
      'tweet.fields': 'created_at,author_id',
      expansions: 'author_id',
      'user.fields': 'username',
    });
    if (sinceId) qs.set('since_id', sinceId);
    const r = await this.http.json<{
      data?: { id: string; text: string; author_id: string; created_at?: string }[];
      includes?: { users?: { id: string; username: string }[] };
      meta?: { newest_id?: string };
    }>(`https://api.x.com/2/tweets/search/recent?${qs}`, {
      headers: { authorization: `Bearer ${this.bearer}` },
      label: 'x:recent',
    });
    const users = new Map((r.includes?.users ?? []).map((u) => [u.id, u.username]));
    return {
      tweets: (r.data ?? []).map((t) => ({
        id: t.id,
        text: t.text,
        author: users.get(t.author_id) ?? t.author_id,
        createdAt: t.created_at ? Date.parse(t.created_at) : Date.now(),
      })),
      newestId: r.meta?.newest_id,
    };
  }
}

/** twitterapi.io (third-party, unofficial). One page ≈ 20 tweets. */
export class TwitterApiIoProvider implements XProvider {
  constructor(
    private http: HttpClient,
    private key: string,
  ) {}
  async search(query: string, _maxReads: number, sinceId?: string) {
    const qs = new URLSearchParams({ query: sinceId ? `${query} since_id:${sinceId}` : query, queryType: 'Latest' });
    const r = await this.http.json<{
      tweets?: { id: string; text: string; createdAt?: string; author?: { userName?: string } }[];
    }>(`https://api.twitterapi.io/twitter/tweet/advanced_search?${qs}`, {
      headers: { 'X-API-Key': this.key },
      label: 'x:twitterapi_io',
    });
    const tweets = (r.tweets ?? []).map((t) => ({
      id: t.id,
      text: t.text,
      author: t.author?.userName ?? 'unknown',
      createdAt: t.createdAt ? Date.parse(t.createdAt) : Date.now(),
    }));
    const newestId = tweets.reduce<string | undefined>(
      (a, t) => (!a || BigInt(t.id) > BigInt(a) ? t.id : a),
      undefined,
    );
    return { tweets, newestId };
  }
}

/** Polls KOL queries within the read budget; `searchToken` is for on-demand checks (Phase 3). */
export class XMentionSource {
  private sinceIds = new Map<string, string>();
  private kols: Set<string>;

  constructor(
    private provider: XProvider,
    private budget: ReadBudget,
    kolHandles: string[],
    private perCallReads = 100,
  ) {
    this.kols = new Set(kolHandles.map((h) => h.toLowerCase()));
  }

  private async run(query: string): Promise<SocialMention[]> {
    const allowed = Math.min(this.perCallReads, this.budget.remaining());
    if (allowed < 10) return [];
    const { tweets, newestId } = await this.provider.search(query, allowed, this.sinceIds.get(query));
    this.budget.consume(Math.max(tweets.length, 1));
    if (newestId) this.sinceIds.set(query, newestId);
    return tweets.map((t) => tweetToMention(t, this.kols)).filter((m): m is SocialMention => !!m);
  }

  async pollKols(): Promise<SocialMention[]> {
    const out: SocialMention[] = [];
    for (const q of kolQueries([...this.kols])) out.push(...(await this.run(q)));
    return out;
  }

  searchToken(mint: string, ticker?: string): Promise<SocialMention[]> {
    return this.run(ticker ? `(${mint} OR $${ticker}) -is:retweet` : mint);
  }
}
