import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import 'dotenv/config';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Secrets and deployment switches — from environment only. */
export const EnvSchema = z.object({
  HELIUS_API_KEY: z.string().optional(),
  /** Overrides: any Solana RPC works for the standard methods we use. */
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_WS_URL: z.string().optional(),
  BIRDEYE_API_KEY: z.string().optional(),

  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USER_AGENT: z.string().optional(),

  TELEGRAM_API_ID: z.string().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_SESSION: z.string().optional(),

  X_PROVIDER: z.enum(['off', 'official', 'twitterapi_io']).default('off'),
  X_BEARER_TOKEN: z.string().optional(),
  TWITTERAPI_IO_KEY: z.string().optional(),

  DB_PATH: z.string().default('./data/scanner.db'),
  CONFIG_PATH: z.string().default('./config/default.json'),

  ENABLE_ONCHAIN: bool(true),
  ENABLE_PUMPFUN_TRADES: bool(true),
  ENABLE_DEXSCREENER: bool(true),
  ENABLE_GECKOTERMINAL: bool(true),
  ENABLE_REDDIT: bool(false),
  ENABLE_TELEGRAM: bool(false),
  ENABLE_SMART_WALLETS: bool(false),

  SMART_WALLETS: csv,
  KOL_X_HANDLES: csv,
  TELEGRAM_CHANNELS: csv,
  TELEGRAM_KOL_CHANNELS: csv,
});
export type Env = z.infer<typeof EnvSchema>;

/** Tunable, non-secret settings — from config/*.json. Phase 2+ add their own sections. */
export const SettingsSchema = z.object({
  ingest: z.object({
    /** Tokens are dropped from active tracking after this age unless they show activity. */
    trackMaxAgeSec: z.number().positive().default(6 * 3600),
    maxTrackedTokens: z.number().int().positive().default(2000),
    dexscreenerRefreshSec: z.number().positive().default(20),
    dexscreenerReqPerMin: z.number().positive().default(250),
    geckoPollSec: z.number().positive().default(30),
    geckoReqPerMin: z.number().positive().default(8),
    trendingPollSec: z.number().positive().default(60),
    bondingCurveRefreshSec: z.number().positive().default(15),
    holdersRefreshSec: z.number().positive().default(120),
    holderCountMaxPages: z.number().int().positive().default(5),
    holdersPerCycle: z.number().int().positive().default(10),
    curveFromTradeThrottleMs: z.number().nonnegative().default(5000),
    tradeRetentionHours: z.number().positive().default(48),
    rpcReqPerSec: z.number().positive().default(8),
    dasReqPerSec: z.number().positive().default(1.5),
    /** Wait this long after creation before fetching a pool tx (lets RPC catch up). */
    poolTxFetchDelayMs: z.number().nonnegative().default(1500),
    /**
     * Programs to stream logs from. Raydium AMM v4 / CLMM and Meteora DLMM carry
     * every swap on those programs (very high WS bandwidth = Helius credits), so they
     * are off by default; new pairs there are still picked up via DexScreener/Gecko.
     */
    venues: z
      .array(
        z.enum([
          'pumpfun',
          'pumpswap',
          'raydium_amm_v4',
          'raydium_cpmm',
          'raydium_clmm',
          'raydium_launchlab',
          'meteora_dlmm',
          'meteora_damm_v1',
          'meteora_damm_v2',
          'meteora_dbc',
        ]),
      )
      .default(['pumpfun', 'pumpswap', 'raydium_cpmm', 'raydium_launchlab', 'meteora_damm_v2', 'meteora_dbc']),
  }),
  social: z.object({
    subreddits: z.array(z.string()).default(['solana', 'CryptoMoonShots', 'SolanaMemeCoins']),
    redditPollSec: z.number().positive().default(60),
    xPollSec: z.number().positive().default(120),
    /** Hard budget: posts read per UTC day across all X calls. */
    xMaxReadsPerDay: z.number().int().nonnegative().default(2000),
    velocityWindowsSec: z.array(z.number().positive()).default([300, 3600]),
  }),
  programs: z.record(z.string()).default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export interface AppConfig {
  env: Env;
  settings: Settings;
  rpcUrl: string | null;
  wsUrl: string | null;
}

export function loadConfig(envSrc: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(envSrc);
  const path = resolve(env.CONFIG_PATH);
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const settings = SettingsSchema.parse({ ingest: {}, social: {}, ...raw });

  const rpcUrl =
    env.SOLANA_RPC_URL ??
    (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : null);
  const wsUrl =
    env.SOLANA_WS_URL ??
    (env.HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : null);
  return { env, settings, rpcUrl, wsUrl };
}
