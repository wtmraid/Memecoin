/**
 * One-off scan of a token from the command line (same as pasting the CA to the bot).
 * Usage: npm run scan -- <CA>
 * Note: bundler/sniper on-chain estimates need the live stream to have seen the launch;
 * a cold scan relies on GMGN for those.
 */
import { loadConfig } from '../src/config/index.js';
import { EventBus } from '../src/core/bus.js';
import { HttpClient, TokenBucket } from '../src/core/http.js';
import { logger } from '../src/core/logger.js';
import { TradeBooks } from '../src/analysis/tradeBook.js';
import { DexScreenerClient } from '../src/ingest/market/dexscreener.js';
import { SolanaRpc } from '../src/ingest/onchain/rpc.js';
import { MentionTracker } from '../src/ingest/social/velocity.js';
import { TokenRegistry } from '../src/pipeline/registry.js';
import { GmgnClient } from '../src/safety/gmgn.js';
import { JupiterSellSim } from '../src/safety/jupiter.js';
import { fetchMintInfo } from '../src/safety/mintInfo.js';
import { makeClusterAnalyzer } from '../src/safety/clusters.js';
import { fetchHolderStats } from '../src/ingest/onchain/holders.js';
import { RugcheckClient } from '../src/safety/rugcheck.js';
import { Evaluator } from '../src/strategy/evaluator.js';
import { formatScan, toPlain } from '../src/alerts/format.js';
import { extractMints } from '../src/ingest/social/extract.js';

const mint = extractMints(process.argv.slice(2).join(' '))[0];
if (!mint) {
  console.error('usage: npm run scan -- <token CA>');
  process.exit(1);
}
const cfg = loadConfig();
const { env, settings } = cfg;
const bus = new EventBus();
const http = (rps: number) => new HttpClient(new TokenBucket(rps, Math.max(1, Math.ceil(rps))));
const ds = new DexScreenerClient(http(4));
const registry = new TokenRegistry(bus, { marketSnapshots: (m) => ds.snapshots(m) }, logger, {
  trackMaxAgeSec: 3600, maxTrackedTokens: 10, marketRefreshSec: 60, holdersRefreshSec: 600, curveRefreshSec: 60, holdersPerCycle: 1, curveFromTradeThrottleMs: 0,
});
const rpc = cfg.rpcUrl ? new SolanaRpc(cfg.rpcUrl, http(5)) : null;
const ev = new Evaluator(
  {
    bus,
    registry,
    books: new TradeBooks(),
    mentions: new MentionTracker(),
    log: logger,
    gmgn: env.GMGN_API_KEY ? new GmgnClient(http(2), env.GMGN_API_KEY) : undefined,
    mintInfo: rpc ? (m) => fetchMintInfo(rpc, m) : undefined,
    rugcheck: env.ENABLE_RUGCHECK ? new RugcheckClient(http(1)) : undefined,
    sellSim: new JupiterSellSim(http(env.JUPITER_API_KEY ? 0.9 : 0.45), env.JUPITER_API_KEY),
    marketSnapshots: (m) => ds.snapshots(m),
    clusters: rpc
      ? makeClusterAnalyzer(rpc, (m) => fetchHolderStats(rpc, m, { maxPages: 1, useDas: false }), {
          maxHolders: settings.filters.clusterMaxHolders,
          freshMaxTx: settings.filters.freshMaxTx,
          hubMinTxPerDay: settings.filters.hubMinTxPerDay,
        })
      : undefined,
  },
  { filters: settings.filters, scoring: settings.scoring, strategy: settings.strategy },
);
// SOL/USD for market-cap math (SOL's own most liquid pair is SOL/USDC).
const solSnap = (await ds.snapshots(['So11111111111111111111111111111111111111112']).catch(() => new Map())).get('So11111111111111111111111111111111111111112');
if (solSnap?.priceUsd) ev.sol.update(solSnap.priceUsd);
const r = await ev.evaluate(mint, { deep: true, force: true });
console.log(toPlain(formatScan(r)));
process.exit(0);
