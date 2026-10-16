import type { HttpClient } from '../../core/http.js';
import type { SocialMention } from '../../core/types.js';
import { extractMints, extractTickers } from './extract.js';

interface RedditListing {
  data?: {
    children?: {
      data?: {
        name?: string;
        author?: string;
        subreddit?: string;
        title?: string;
        selftext?: string;
        url?: string;
        permalink?: string;
        created_utc?: number;
      };
    }[];
  };
}

/** Pure: listing JSON → mentions that reference at least one CA or ticker. */
export function mapRedditListing(l: RedditListing): SocialMention[] {
  const out: SocialMention[] = [];
  for (const c of l.data?.children ?? []) {
    const d = c.data;
    if (!d?.name) continue;
    const text = [d.title, d.selftext, d.url].filter(Boolean).join('\n');
    const mints = extractMints(text);
    const tickers = extractTickers(text);
    if (!mints.length && !tickers.length) continue;
    out.push({
      source: 'reddit',
      id: d.name,
      author: d.author ?? 'unknown',
      channel: `r/${d.subreddit ?? '?'}`,
      text: text.slice(0, 2000),
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : undefined,
      mints,
      tickers,
      isKol: false,
      ts: (d.created_utc ?? Date.now() / 1000) * 1000,
    });
  }
  return out;
}

/**
 * Official Reddit Data API, application-only OAuth (client_credentials).
 * Free tier: 100 QPM per client, non-commercial use. We poll /new of a few subs.
 */
export class RedditClient {
  private token: { value: string; exp: number } | null = null;

  constructor(
    private http: HttpClient,
    private creds: { clientId: string; clientSecret: string; userAgent: string },
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64');
    const r = await this.http.json<{ access_token: string; expires_in: number }>(
      'https://www.reddit.com/api/v1/access_token',
      {
        form: { grant_type: 'client_credentials' },
        headers: { authorization: `Basic ${basic}`, 'user-agent': this.creds.userAgent },
        label: 'reddit:token',
      },
    );
    this.token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return r.access_token;
  }

  async newPosts(subreddit: string, limit = 50): Promise<SocialMention[]> {
    const token = await this.accessToken();
    const l = await this.http.json<RedditListing>(
      `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/new?limit=${limit}&raw_json=1`,
      { headers: { authorization: `Bearer ${token}`, 'user-agent': this.creds.userAgent }, label: 'reddit:new' },
    );
    return mapRedditListing(l);
  }
}
