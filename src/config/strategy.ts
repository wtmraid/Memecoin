import { z } from 'zod';

/**
 * Safety-filter thresholds (Phase 2). Percentages are 0–100. A token must pass every
 * enabled hard filter to be alerted. Defaults are deliberately strict: the goal is to
 * avoid rugs first and find runners second. Tune them from `npm run report` data.
 */
export const FiltersSchema = z.object({
  requireMintRevoked: z.boolean().default(true),
  requireFreezeRevoked: z.boolean().default(true),
  /** Reject Token-2022 extensions that let the issuer take or freeze your tokens. */
  rejectDangerousExtensions: z.boolean().default(true),
  maxTaxPct: z.number().default(5),
  maxTop10Pct: z.number().default(30),
  maxBundlerPct: z.number().default(20),
  maxPhishingPct: z.number().default(10),
  maxInsiderPct: z.number().default(10),
  maxSniperPct: z.number().default(10),
  maxSniperCount: z.number().default(25),
  /** On-chain sniper definition: first buy within this many slots after creation (~0.4 s/slot). */
  sniperWindowSlots: z.number().int().default(3),
  maxDevHoldPct: z.number().default(10),
  maxDevTeamHoldPct: z.number().default(15),
  /** GMGN rug_ratio, 0–1. GMGN's own guide: <0.10 safe, >0.30 danger. */
  maxRugRatio: z.number().default(0.1),
  /** Serial-launcher guard: this creator's launches seen in the last 24h (our DB). */
  maxCreatorLaunches24h: z.number().int().default(3),
  /** Serial farm: many launches with almost none graduating. */
  serialFarmMinLaunches: z.number().int().default(30),
  serialFarmMaxGradRate: z.number().default(0.03),
  /** Non-curve pools: share of LP burned/locked. pump.fun curve tokens are exempt (no LP to pull). */
  minLpBurnedOrLockedPct: z.number().default(90),
  minLiquidityUsd: z.number().default(8000),
  /** pump.fun curve: real SOL in the curve. */
  minCurveSol: z.number().default(5),
  minAgeSec: z.number().default(60),
  minHolders: z.number().int().default(30),
  /** Wash trading: average transactions per unique trader over the token's life. */
  maxTxPerTrader: z.number().default(6),
  /** Wash trading: 1h volume / liquidity. Above this with few holders = fake volume. */
  maxVolumeToLiquidity1h: z.number().default(15),
  /** RugCheck score_normalised 0–100 (higher = riskier). */
  maxRugcheckScore: z.number().default(60),
  /** Sell simulation (honeypot): round-trip loss for the test size, incl. price impact. */
  requireSellSim: z.boolean().default(true),
  maxSellLossPct: z.number().default(15),
  sellSimSizeSol: z.number().default(0.5),
  requireSocials: z.boolean().default(true),
  /** Reject when the same X account / website was used by another token in the last 7 days. */
  rejectRecycledSocials: z.boolean().default(true),
});
export type FilterSettings = z.infer<typeof FiltersSchema>;

export const ScoringSchema = z.object({
  weights: z
    .object({
      buyPressure: z.number().default(15),
      buyerVelocity: z.number().default(15),
      volumeMomentum: z.number().default(10),
      holderGrowth: z.number().default(10),
      liquidityGrowth: z.number().default(10),
      smartMoney: z.number().default(15),
      social: z.number().default(10),
      distribution: z.number().default(10),
      devQuality: z.number().default(5),
    })
    .default({}),
  /** Unique buyers in 5 minutes that counts as maximum velocity. */
  buyerVelocityTarget5m: z.number().default(60),
  /** Holders that counts as full holder-growth credit, per minute of age (curve tokens). */
  holdersPerMinTarget: z.number().default(8),
  minScoreSnipe: z.number().default(65),
  minScoreScalp: z.number().default(70),
});
export type ScoringSettings = z.infer<typeof ScoringSchema>;

export const StrategySchema = z.object({
  evalIntervalSec: z.number().default(5),
  deepCheckTtlSec: z.number().default(60),
  deepCheckConcurrency: z.number().int().default(2),
  recheckRejectedAfterSec: z.number().default(300),
  snipe: z
    .object({
      maxAgeSec: z.number().default(900),
      minUniqueBuyers: z.number().int().default(25),
      minCurveProgress: z.number().default(0.12),
      /** Late-curve entries often get dumped at migration — skip by default. */
      maxCurveProgress: z.number().default(0.85),
      minBuySellRatio2m: z.number().default(1.2),
    })
    .default({}),
  scalp: z
    .object({
      minAgeSec: z.number().default(900),
      minLiquidityUsd: z.number().default(15000),
      min5mVolumeUsd: z.number().default(5000),
      /** 5m volume vs the average 5m volume of the last hour. */
      volumeBreakoutX: z.number().default(2.5),
      minPriceChange5mPct: z.number().default(3),
      /** Don't chase a vertical candle. */
      maxPriceChange5mPct: z.number().default(40),
      minBuySellRatio5m: z.number().default(1.3),
      cooldownSec: z.number().default(3600),
    })
    .default({}),
  entry: z
    .object({
      /** Entry is valid up to this % above the signal price; above it, wait for a pullback. */
      maxChasePct: z.number().default(15),
    })
    .default({}),
  exit: z
    .object({
      stopLossPct: z.number().default(30),
      tp1Multiple: z.number().default(2),
      tp1SellPct: z.number().default(50),
      tp2Multiple: z.number().default(3),
      tp2SellPct: z.number().default(25),
      /** After TP1, exit the rest if price falls this % from its peak. */
      trailingStopPct: z.number().default(30),
      /** Exit if not up at least `timeStopMinGainPct` after this many minutes. */
      timeStopMin: z.number().default(30),
      timeStopMinGainPct: z.number().default(20),
      /** Take this % of the remaining bag when the curve completes/migrates while in profit. */
      migrationSellPct: z.number().default(50),
      /** Emergency: dev sold at least this % of their bag since the signal. */
      devSellPct: z.number().default(20),
      /** Emergency: liquidity fell this % within 5 minutes (DEX pools). */
      liquidityDropPct: z.number().default(30),
      /** Emergency: sells ≥ this × buys over 2 minutes while ≥ `sellPressureDrawdownPct` off peak. */
      sellPressureRatio: z.number().default(3),
      sellPressureDrawdownPct: z.number().default(25),
      /** Emergency: launch bundle wallets dumped this % of what they held at the signal. */
      bundleExodusPct: z.number().default(30),
      maxHoldHours: z.number().default(24),
    })
    .default({}),
  paper: z
    .object({
      positionSol: z.number().default(0.5),
      slippagePct: z.number().default(3),
      venueFeePct: z.number().default(1.25),
      priorityFeeSol: z.number().default(0.0005),
      jitoTipSol: z.number().default(0.0005),
      /** Simulated reaction time: entry fills at the first price seen after this delay. */
      latencyMs: z.number().default(1500),
    })
    .default({}),
  outcomeCheckpointsMin: z.array(z.number()).default([1, 5, 15, 60, 1440]),
});
export type StrategySettings = z.infer<typeof StrategySchema>;

export const AlertsSchema = z.object({
  minScore: z.number().default(65),
});
export type AlertSettings = z.infer<typeof AlertsSchema>;
