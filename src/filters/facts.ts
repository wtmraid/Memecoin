import type { RugcheckSummary } from '../safety/rugcheck.js';
import type { SellSimResult } from '../safety/jupiter.js';
import type { SocialCheck, SocialLinks } from '../safety/socials.js';

export type Source = 'gmgn' | 'onchain' | 'rpc' | 'dexscreener' | 'rugcheck';

/**
 * Everything known about a token at evaluation time. `null` = unknown (source missing
 * or not fetched yet). Percentages are 0–100. Filters and the scorer only read this.
 */
export interface TokenFacts {
  mint: string;
  symbol?: string;
  name?: string;
  now: number;
  ageSec: number | null;
  venue?: string;
  onCurve: boolean;
  migrated: boolean;
  curveProgress: number | null;
  curveSol: number | null;
  priceSol: number | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  athMcapUsd: number | null;
  liquidityUsd: number | null;

  // GMGN "Core Metrics" (GMGN value preferred, on-chain fallback)
  taxPct: number | null;
  top10Pct: number | null;
  bundlerPct: number | null;
  phishingPct: number | null;
  insiderPct: number | null;
  sniperPct: number | null;
  sniperCount: number | null;
  devHoldPct: number | null;
  devTeamHoldPct: number | null;
  devMigrated: number | null;
  devLaunches: number | null;
  devGradRate: number | null;
  rugRatio: number | null;
  /** Bubblemaps-style cluster analysis of top holders. */
  clusterPct: number | null;
  devLinkedPct: number | null;
  freshWalletPct: number | null;
  clusters: { pct: number; wallets: number; includesDev: boolean }[];
  sources: Partial<Record<string, Source>>;

  creator: string | null;
  creatorStatus: 'hold' | 'sold' | 'closed' | null;
  devSoldPct: number | null;
  creatorLaunches24h: number | null;

  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  dangerousExtensions: string[] | null;
  /** Pools with withdrawable LP. pump.fun curve = not applicable (nobody can pull it). */
  lp: { applies: boolean; burnedOrLockedPct: number | null; burned: boolean | null };

  holderCount: number | null;
  txPerTrader: number | null;
  volToLiq1h: number | null;
  isWashTrading: boolean | null;

  rugcheck: RugcheckSummary | null;
  sellSim: SellSimResult | null;
  socials: SocialLinks;
  socialCheck: SocialCheck | null;
  recycledWith: string[];

  momentum: {
    buys2m: number | null;
    sells2m: number | null;
    buys5m: number | null;
    sells5m: number | null;
    uniqueBuyers5m: number | null;
    uniqueBuyersTotal: number | null;
    volume5mUsd: number | null;
    /** Average 5-minute volume over the last hour. */
    volumeAvg5mUsd: number | null;
    priceChange5mPct: number | null;
    /** Curve SOL or pool liquidity growth over 5 min, %. */
    liquidityGrowth5mPct: number | null;
    holdersPerMin: number | null;
  };
  smartMoney: { gmgnSmart: number | null; gmgnRenowned: number | null; watchedWalletBuys: number };
  social: {
    mentions1h: number;
    mentions5m: number;
    kolMentions1h: number;
    uniqueAuthors1h: number;
    negativeMentions1h: number;
    acceleration: number;
  };
  /** Which data sources were available for this evaluation. */
  coverage: { gmgn: boolean; onchainBook: boolean; rpc: boolean; market: boolean; sellSim: boolean; rugcheck: boolean; clusters: boolean };
}

export function emptyFacts(mint: string, now: number): TokenFacts {
  return {
    mint,
    now,
    ageSec: null,
    onCurve: false,
    migrated: false,
    curveProgress: null,
    curveSol: null,
    priceSol: null,
    priceUsd: null,
    mcapUsd: null,
    athMcapUsd: null,
    liquidityUsd: null,
    taxPct: null,
    top10Pct: null,
    bundlerPct: null,
    phishingPct: null,
    insiderPct: null,
    sniperPct: null,
    sniperCount: null,
    devHoldPct: null,
    devTeamHoldPct: null,
    devMigrated: null,
    devLaunches: null,
    devGradRate: null,
    rugRatio: null,
    clusterPct: null,
    devLinkedPct: null,
    freshWalletPct: null,
    clusters: [],
    sources: {},
    creator: null,
    creatorStatus: null,
    devSoldPct: null,
    creatorLaunches24h: null,
    mintRenounced: null,
    freezeRenounced: null,
    dangerousExtensions: null,
    lp: { applies: true, burnedOrLockedPct: null, burned: null },
    holderCount: null,
    txPerTrader: null,
    volToLiq1h: null,
    isWashTrading: null,
    rugcheck: null,
    sellSim: null,
    socials: {},
    socialCheck: null,
    recycledWith: [],
    momentum: {
      buys2m: null,
      sells2m: null,
      buys5m: null,
      sells5m: null,
      uniqueBuyers5m: null,
      uniqueBuyersTotal: null,
      volume5mUsd: null,
      volumeAvg5mUsd: null,
      priceChange5mPct: null,
      liquidityGrowth5mPct: null,
      holdersPerMin: null,
    },
    smartMoney: { gmgnSmart: null, gmgnRenowned: null, watchedWalletBuys: 0 },
    social: { mentions1h: 0, mentions5m: 0, kolMentions1h: 0, uniqueAuthors1h: 0, negativeMentions1h: 0, acceleration: 0 },
    coverage: { gmgn: false, onchainBook: false, rpc: false, market: false, sellSim: false, rugcheck: false, clusters: false },
  };
}
