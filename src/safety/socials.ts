export interface SocialLinks {
  twitter?: string;
  website?: string;
  telegram?: string;
}

export interface SocialCheck {
  hasAny: boolean;
  /** Normalised keys (x handle, website host) used for the recycled-socials lookup. */
  keys: string[];
  problems: string[];
}

const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'cutt.ly', 'rb.gy', 'is.gd', 'linktr.ee']);
const X_HOSTS = new Set(['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com', 'mobile.twitter.com']);
/** Paths that are not an account profile: a tweet, a community, a search. */
const X_NON_PROFILE = /^\/(i\/|search|hashtag|home|intent)|\/status\/\d+/;

function parse(u: string): URL | null {
  try {
    const url = new URL(u.startsWith('http') ? u : `https://${u}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Static checks on socials. A token "borrowing" a famous tweet or community instead of
 * its own account, link shorteners and malformed URLs are classic low-effort-rug signs.
 * X account age needs the paid X API, so recycled-account detection is done via our own
 * DB: the same handle / site used by a different token recently.
 */
export function checkSocials(s: SocialLinks): SocialCheck {
  const problems: string[] = [];
  const keys: string[] = [];
  if (s.twitter) {
    const u = parse(s.twitter);
    if (!u || !X_HOSTS.has(u.hostname)) problems.push('X link is not an x.com URL');
    else if (X_NON_PROFILE.test(u.pathname)) problems.push('X link points to a tweet/community, not the project account');
    else {
      const handle = u.pathname.split('/').filter(Boolean)[0];
      if (handle) keys.push(`x:${handle.toLowerCase()}`);
      else problems.push('X link has no handle');
    }
  }
  if (s.website) {
    const u = parse(s.website);
    if (!u) problems.push('website URL is malformed');
    else if (SHORTENERS.has(u.hostname)) problems.push(`website uses a link shortener (${u.hostname})`);
    else if (X_HOSTS.has(u.hostname)) problems.push('website is just an X link');
    else keys.push(`web:${u.hostname.replace(/^www\./, '')}`);
  }
  if (s.telegram) {
    const u = parse(s.telegram);
    if (!u || !/^(t\.me|telegram\.me)$/.test(u.hostname)) problems.push('Telegram link is not a t.me URL');
    else {
      const name = u.pathname.split('/').filter(Boolean)[0];
      if (name) keys.push(`tg:${name.toLowerCase()}`);
    }
  }
  return { hasAny: !!(s.twitter || s.website || s.telegram), keys, problems };
}

/** In-memory index of social keys → mints, to catch recycled accounts across launches. */
export class SocialIndex {
  private byKey = new Map<string, { mint: string; ts: number }[]>();
  constructor(private windowMs = 7 * 24 * 3600_000) {}

  /** Records `mint`'s keys and returns other mints that used any of them within the window. */
  record(mint: string, keys: string[], now = Date.now()): string[] {
    const others = new Set<string>();
    for (const k of keys) {
      const list = (this.byKey.get(k) ?? []).filter((e) => now - e.ts < this.windowMs);
      for (const e of list) if (e.mint !== mint) others.add(e.mint);
      if (!list.some((e) => e.mint === mint)) list.push({ mint, ts: now });
      this.byKey.set(k, list);
    }
    return [...others];
  }
}
