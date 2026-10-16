import { describe, expect, it } from 'vitest';
import { buildPoolCreated, extractPairFromTx, isPoolCreation } from '../src/ingest/onchain/pools.js';
import { PROGRAM_IDS, USDC_MINT, WSOL_MINT } from '../src/ingest/onchain/programs.js';
import { key, parsedTx, tb } from './helpers.js';

const n = (programId: string, lines: string[], err: unknown = null) => ({
  signature: 'sigP',
  slot: 5,
  err,
  logs: [`Program ${programId} invoke [1]`, ...lines, `Program ${programId} success`],
});

describe('pool-creation markers', () => {
  const cases: [keyof typeof PROGRAM_IDS, string][] = [
    ['pumpswap', 'Program log: Instruction: CreatePool'],
    ['raydium_amm_v4', 'Program log: initialize2: InitializeInstruction2 { nonce: 254, open_time: 0 }'],
    ['raydium_cpmm', 'Program log: Instruction: Initialize'],
    ['raydium_clmm', 'Program log: Instruction: CreatePool'],
    ['raydium_launchlab', 'Program log: Instruction: InitializeV2'],
    ['meteora_dlmm', 'Program log: Instruction: InitializeLbPair2'],
    ['meteora_damm_v2', 'Program log: Instruction: InitializeCustomizablePool'],
    ['meteora_damm_v1', 'Program log: Instruction: InitializePermissionlessConstantProductPoolWithConfig2'],
    ['meteora_dbc', 'Program log: Instruction: InitializeVirtualPoolWithSplToken'],
  ];
  for (const [venue, line] of cases) {
    it(`detects ${venue}`, () => {
      expect(isPoolCreation(n(PROGRAM_IDS[venue], [line]), venue as never, PROGRAM_IDS[venue])).toBe(true);
    });
  }

  it('ignores swaps', () => {
    expect(
      isPoolCreation(n(PROGRAM_IDS.raydium_cpmm, ['Program log: Instruction: SwapBaseInput']), 'raydium_cpmm', PROGRAM_IDS.raydium_cpmm),
    ).toBe(false);
  });
  it('ignores failed transactions', () => {
    const id = PROGRAM_IDS.pumpswap;
    expect(isPoolCreation(n(id, ['Program log: Instruction: CreatePool'], { err: 1 }), 'pumpswap', id)).toBe(false);
  });
  it('ignores a marker logged by a different program', () => {
    const id = PROGRAM_IDS.raydium_cpmm;
    expect(isPoolCreation(n(key(50), ['Program log: Instruction: Initialize']), 'raydium_cpmm', id)).toBe(false);
  });
});

describe('extractPairFromTx', () => {
  const creator = key(1);
  const vaultAuth = key(2);
  const base = key(3);
  const lpMint = key(4);

  it('finds the pair from vaults sharing a non-signer owner and ignores the LP mint', () => {
    const tx = parsedTx({
      signers: [creator],
      post: [
        tb(5, base, vaultAuth, 1_000n),
        tb(6, WSOL_MINT, vaultAuth, 5_000n, 9),
        tb(7, lpMint, creator, 99n), // LP tokens to creator
        tb(8, base, creator, 0n),
      ],
    });
    expect(extractPairFromTx(tx)).toEqual({ baseMint: base, quoteMint: WSOL_MINT, vaultOwner: vaultAuth });
  });

  it('orients base/quote when the quote is listed first', () => {
    const tx = parsedTx({ signers: [creator], post: [tb(5, USDC_MINT, vaultAuth, 1n), tb(6, base, vaultAuth, 1n)] });
    expect(extractPairFromTx(tx)).toMatchObject({ baseMint: base, quoteMint: USDC_MINT });
  });

  it('falls back to single non-quote mint + quote', () => {
    const tx = parsedTx({ signers: [creator], post: [tb(5, base, key(20), 1n), tb(6, WSOL_MINT, key(21), 1n)] });
    expect(extractPairFromTx(tx)).toEqual({ baseMint: base, quoteMint: WSOL_MINT });
  });

  it('returns null when there are no token balances', () => {
    expect(extractPairFromTx(parsedTx({ signers: [creator] }))).toBeNull();
  });

  it('buildPoolCreated uses block time', () => {
    const tx = parsedTx({ signers: [creator], post: [tb(5, base, vaultAuth, 1n), tb(6, WSOL_MINT, vaultAuth, 1n)] });
    const ev = buildPoolCreated('pumpswap', { signature: 'S', slot: 1, err: null, logs: [] }, tx);
    expect(ev).toMatchObject({ venue: 'pumpswap', baseMint: base, quoteMint: WSOL_MINT, ts: 1_760_000_000_000 });
  });
});
