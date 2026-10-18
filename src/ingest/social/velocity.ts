import type { SocialMention, SocialSource } from '../../core/types.js';

/** Words that, in a post about a token, mean people are calling it a rug. */
const NEGATIVE = /\b(rug(ged|pull)?|scam|honeypot|hp|jeet(s|ed)?|dump(ed|ing)?|dead|exit ?scam|bundled)\b/i;
export const isNegativeText = (t: string) => NEGATIVE.test(t);

interface Hit {
  ts: number;
  negative: boolean;
  author: string;
  source: SocialSource;
  isKol: boolean;
}

export interface Velocity {
  key: string;
  windowSec: number;
  count: number;
  uniqueAuthors: number;
  kolMentions: number;
  negativeMentions: number;
  /** Mentions per minute in this window. */
  perMin: number;
  /** count(this window) / count(previous window of same length); Infinity when previous is 0. */
  acceleration: number;
  bySource: Partial<Record<SocialSource, number>>;
}

/**
 * Rolling mention counts keyed by mint (`mint:<addr>`) and ticker (`ticker:<SYM>`).
 * In-memory; persistence of raw mentions is in SQLite so this can be rebuilt.
 */
export class MentionTracker {
  private hits = new Map<string, Hit[]>();
  constructor(private maxAgeSec = 2 * 3600) {}

  static keys(m: Pick<SocialMention, 'mints' | 'tickers'>): string[] {
    return [...m.mints.map((x) => `mint:${x}`), ...m.tickers.map((t) => `ticker:${t}`)];
  }

  record(m: SocialMention): string[] {
    const keys = MentionTracker.keys(m);
    for (const k of keys) {
      const arr = this.hits.get(k) ?? [];
      arr.push({ ts: m.ts, author: m.author, source: m.source, isKol: m.isKol, negative: isNegativeText(m.text) });
      this.hits.set(k, arr);
    }
    return keys;
  }

  velocity(key: string, windowSec: number, now = Date.now()): Velocity {
    const arr = this.hits.get(key) ?? [];
    const from = now - windowSec * 1000;
    const prevFrom = from - windowSec * 1000;
    const cur = arr.filter((h) => h.ts > from && h.ts <= now);
    const prev = arr.filter((h) => h.ts > prevFrom && h.ts <= from).length;
    const bySource: Velocity['bySource'] = {};
    for (const h of cur) bySource[h.source] = (bySource[h.source] ?? 0) + 1;
    return {
      key,
      windowSec,
      count: cur.length,
      uniqueAuthors: new Set(cur.map((h) => `${h.source}:${h.author}`)).size,
      kolMentions: cur.filter((h) => h.isKol).length,
      negativeMentions: cur.filter((h) => h.negative).length,
      perMin: cur.length / (windowSec / 60),
      acceleration: prev === 0 ? (cur.length ? Infinity : 0) : cur.length / prev,
      bySource,
    };
  }

  prune(now = Date.now()) {
    const cutoff = now - this.maxAgeSec * 1000;
    for (const [k, arr] of this.hits) {
      const kept = arr.filter((h) => h.ts > cutoff);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }

  get size() {
    return this.hits.size;
  }
}
