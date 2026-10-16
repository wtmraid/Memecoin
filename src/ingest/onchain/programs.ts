import type { Venue } from '../../core/types.js';

/** Mainnet program IDs. Sources in docs/RESEARCH.md. Override via config.programs[venue]. */
export const PROGRAM_IDS: Record<Venue, string> = {
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  raydium_amm_v4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  raydium_cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  raydium_clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  raydium_launchlab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  meteora_dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  meteora_damm_v1: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  meteora_damm_v2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  meteora_dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
};

/**
 * Log markers that mean "a pool / launch was created" for each venue, matched only
 * inside that program's own invocation frame. Anchor programs log
 * `Program log: Instruction: <PascalName>`; Raydium AMM v4 (non-Anchor) logs `initialize2: ...`.
 */
export const POOL_CREATE_MARKERS: Record<Exclude<Venue, 'pumpfun'>, RegExp> = {
  pumpswap: /^Program log: Instruction: CreatePool$/,
  raydium_amm_v4: /^Program log: initialize2: /,
  raydium_cpmm: /^Program log: Instruction: Initialize(WithPermission)?$/,
  raydium_clmm: /^Program log: Instruction: CreatePool$/,
  raydium_launchlab: /^Program log: Instruction: Initialize(V2|WithToken2022)?$/,
  meteora_dlmm:
    /^Program log: Instruction: Initialize(LbPair2?|PermissionLbPair|CustomizablePermissionlessLbPair2?)$/,
  meteora_damm_v1:
    /^Program log: Instruction: Initialize(PermissionlessPool\w*|PermissionlessConstantProductPool\w*|CustomizablePermissionlessConstantProductPool)$/,
  meteora_damm_v2: /^Program log: Instruction: Initialize(Pool|CustomizablePool|PoolWithDynamicConfig)$/,
  meteora_dbc: /^Program log: Instruction: InitializeVirtualPoolWith(SplToken|Token2022)$/,
};

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export const PUMP_CURVE_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n; // 793.1M × 1e6
export const PUMP_TOKEN_DECIMALS = 6;

export function resolvePrograms(overrides: Record<string, string> = {}): Record<Venue, string> {
  return { ...PROGRAM_IDS, ...(overrides as Partial<Record<Venue, string>>) };
}
