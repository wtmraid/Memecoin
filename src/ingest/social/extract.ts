import bs58 from 'bs58';
import { PROGRAM_IDS, QUOTE_MINTS } from '../onchain/programs.js';

const B58 = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const TICKER = /(?<![\w$])\$([A-Za-z][A-Za-z0-9]{1,9})(?![\w])/g;

const IGNORE_ADDRS = new Set([...Object.values(PROGRAM_IDS), ...QUOTE_MINTS, '11111111111111111111111111111111']);
/** Majors and generic words that are never the memecoin being shilled. */
export const IGNORE_TICKERS = new Set(['SOL', 'USDC', 'USDT', 'BTC', 'ETH', 'BNB', 'JUP', 'USD', 'WSOL']);

export function isSolanaAddress(s: string): boolean {
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** Contract addresses (incl. ones inside dexscreener / pump.fun / birdeye URLs). */
export function extractMints(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(B58)) {
    const a = m[0];
    if (!IGNORE_ADDRS.has(a) && isSolanaAddress(a)) out.add(a);
  }
  return [...out];
}

/** $TICKER cashtags, upper-cased, de-duplicated. */
export function extractTickers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TICKER)) {
    const t = m[1]!.toUpperCase();
    if (!IGNORE_TICKERS.has(t)) out.add(t);
  }
  return [...out];
}
