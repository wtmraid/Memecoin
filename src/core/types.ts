/** Shared domain types. Amounts in raw base units are bigint; USD values are numbers. */

export type Venue =
  | 'pumpfun'
  | 'pumpswap'
  | 'raydium_amm_v4'
  | 'raydium_cpmm'
  | 'raydium_clmm'
  | 'raydium_launchlab'
  | 'meteora_dlmm'
  | 'meteora_damm_v1'
  | 'meteora_damm_v2'
  | 'meteora_dbc';

export interface TokenCreated {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  bondingCurve: string;
  creator: string;
  venue: Venue;
  signature: string;
  slot: number;
  /** ms since epoch, as observed by us (on-chain timestamp when available) */
  ts: number;
}

export interface PoolCreated {
  venue: Venue;
  signature: string;
  slot: number;
  baseMint: string;
  quoteMint: string;
  /** Pool address when it can be determined from the tx; otherwise undefined. */
  pool?: string;
  ts: number;
}

export interface PumpTrade {
  mint: string;
  user: string;
  isBuy: boolean;
  solAmount: bigint;
  tokenAmount: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves?: bigint;
  realTokenReserves?: bigint;
  signature: string;
  slot: number;
  ts: number;
}

export interface PumpComplete {
  mint: string;
  bondingCurve: string;
  user: string;
  signature: string;
  slot: number;
  ts: number;
}

export interface PumpMigrated {
  mint: string;
  pool?: string;
  signature: string;
  slot: number;
  ts: number;
}

export interface BondingCurveState {
  mint: string;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator?: string;
  /** 0..1 share of curve tokens sold */
  progress: number;
  /** SOL price per whole token implied by virtual reserves (6-decimals token) */
  priceSol: number;
}

export interface WindowStats {
  m5: number;
  h1: number;
  h6: number;
  h24: number;
}

export interface MarketSnapshot {
  mint: string;
  source: 'dexscreener' | 'geckoterminal' | 'birdeye';
  pairAddress: string;
  dexId: string;
  symbol?: string;
  name?: string;
  /** Quote asset of the pair (priceNative is denominated in it). */
  quoteMint?: string;
  priceUsd: number | null;
  priceNative: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  volumeUsd: WindowStats;
  buys: WindowStats;
  sells: WindowStats;
  priceChangePct: WindowStats;
  /** Unique buyer/seller wallets per window — only some sources (GeckoTerminal) provide them. */
  uniqueBuyers?: WindowStats;
  uniqueSellers?: WindowStats;
  pairCreatedAt: number | null;
  websites: string[];
  socials: { type: string; url: string }[];
  ts: number;
}

export interface HolderStats {
  mint: string;
  supply: bigint;
  decimals: number;
  /** Largest accounts (token-account level, as returned by getTokenLargestAccounts). */
  top: { address: string; owner?: string; amount: bigint; pct: number }[];
  holderCount: number | null;
  /** True when holderCount hit the pagination cap and is a lower bound. */
  holderCountIsLowerBound: boolean;
  ts: number;
}

export type SocialSource = 'reddit' | 'telegram' | 'x';

export interface SocialMention {
  source: SocialSource;
  /** Post / message id unique within source */
  id: string;
  author: string;
  channel: string;
  text: string;
  url?: string;
  mints: string[];
  tickers: string[];
  isKol: boolean;
  ts: number;
}

export interface WalletTrade {
  wallet: string;
  mint: string;
  side: 'buy' | 'sell';
  tokenDelta: bigint;
  /** SOL change in lamports (negative on buy) including fees */
  solDeltaLamports: bigint;
  signature: string;
  slot: number;
  ts: number;
}

export interface LogNotification {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
}
