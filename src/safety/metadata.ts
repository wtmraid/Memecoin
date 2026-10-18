import type { HttpClient } from '../core/http.js';
import type { SocialLinks } from './socials.js';

/**
 * A token's own metadata JSON (the `uri` in its pump.fun CreateEvent) — this is where
 * pump.fun stores the X / Telegram / website the creator entered, i.e. what the pump.fun
 * page shows. DexScreener only lists socials for paid profiles, so without GMGN this is
 * the only reliable socials source for new launches. Third-party content: only string
 * fields are read, and every link is validated later by checkSocials.
 */
export function ipfsToHttps(uri: string): string | null {
  const u = uri.trim();
  if (u.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${u.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  if (u.startsWith('ar://')) return `https://arweave.net/${u.slice('ar://'.length)}`;
  if (/^https:\/\//.test(u)) return u;
  return null;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.length < 300 ? v.trim() : undefined);

/** Pure: metadata JSON → socials (top-level fields, or Metaplex-style `extensions`). */
export function socialsFromMetadata(j: unknown): SocialLinks {
  if (!j || typeof j !== 'object') return {};
  const o = j as Record<string, unknown>;
  const ext = (o.extensions && typeof o.extensions === 'object' ? o.extensions : {}) as Record<string, unknown>;
  const twitter = str(o.twitter) ?? str(ext.twitter);
  const telegram = str(o.telegram) ?? str(ext.telegram);
  const website = str(o.website) ?? str(ext.website);
  return {
    ...(twitter ? { twitter: twitter.startsWith('http') ? twitter : `https://x.com/${twitter.replace(/^@/, '')}` } : {}),
    ...(telegram ? { telegram: telegram.startsWith('http') ? telegram : `https://t.me/${telegram.replace(/^@/, '')}` } : {}),
    ...(website ? { website } : {}),
  };
}

export async function fetchMetadataSocials(http: HttpClient, uri: string): Promise<SocialLinks | null> {
  const url = ipfsToHttps(uri);
  if (!url) return null;
  return socialsFromMetadata(await http.json<unknown>(url, { label: 'token-metadata', timeoutMs: 6000, retries: 1 }));
}
