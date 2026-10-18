import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

/**
 * Safety guarantee: this bot is read-only. It never holds a wallet key and never
 * builds, signs or sends a transaction. These tests fail if that ever changes.
 * (Live execution, if ever added, must be a deliberate, separately reviewed change.)
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const SOURCES = [...files('src'), ...files('scripts')].map((p) => ({ p, code: readFileSync(p, 'utf8') }));

const FORBIDDEN: [string, RegExp][] = [
  ['send a transaction', /\b(sendTransaction|sendRawTransaction|sendAndConfirm\w*|sendBundle)\b/],
  ['sign a transaction', /\b(signTransaction|signAllTransactions|partialSign|nacl\.sign|ed25519\.sign)\b/],
  ['build a transaction', /\bnew\s+(Versioned)?Transaction\b|\bTransactionMessage\b|\bcompileToV0Message\b/],
  ['load a keypair / private key', /\b(Keypair|fromSecretKey|secretKey|privateKey|PRIVATE_KEY|mnemonic|seedPhrase)\b/],
  ['call a swap/trade endpoint', /swap\/v1\/swap\b|\/v1\/trade\/|\/v1\/cooking\/|\/ultra\/|\/order\b.*jup/],
];

describe('read-only guarantee (cannot touch your wallet)', () => {
  for (const [what, re] of FORBIDDEN) {
    it(`no code can ${what}`, () => {
      const hits = SOURCES.filter((s) => re.test(s.code)).map((s) => s.p);
      expect(hits).toEqual([]);
    });
  }

  it('no Solana web3 / signing libraries are installed as dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.filter((d) => /@solana\/(web3\.js|kit|signers)|tweetnacl|@coral-xyz\/anchor|jito/.test(d))).toEqual([]);
  });

  it('Jupiter is only ever asked for a price QUOTE', () => {
    const urls = SOURCES.flatMap((s) => s.code.match(/https:\/\/[^'"`\s]*jup\.ag[^'"`\s]*/g) ?? []);
    expect(urls).toEqual(['https://api.jup.ag/swap/v1/quote']);
  });

  it('a wallet key put in .env by mistake is ignored, not loaded', () => {
    const cfg = loadConfig({ WALLET_PRIVATE_KEY: 'x', PRIVATE_KEY: 'y', CONFIG_PATH: './config/default.json' });
    expect(JSON.stringify(cfg)).not.toMatch(/WALLET_PRIVATE_KEY|PRIVATE_KEY/);
  });

  it('the only RPC methods used are read-only', () => {
    const methods = new Set(SOURCES.flatMap((s) => [...s.code.matchAll(/call(?:<[\s\S]*?>)?\(\s*'(\w+)'|this\.call\('(\w+)'|'(logsSubscribe)'/g)].map((m) => m[1] ?? m[2] ?? m[3])));
    const READ_ONLY = new Set(['getTransaction', 'getAccountInfo', 'getTokenSupply', 'getTokenLargestAccounts', 'getMultipleAccounts', 'getTokenAccounts', 'logsSubscribe']);
    expect(methods.size).toBeGreaterThanOrEqual(5); // the scan really found the calls
    for (const m of methods) expect(READ_ONLY.has(m!), `unexpected RPC method ${m}`).toBe(true);
  });
});
