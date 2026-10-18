/**
 * Live checks against every configured API — run this on your machine / VPS after
 * filling .env. It verifies the endpoints and response shapes the code relies on.
 * Usage: npm run smoke
 */
import { loadConfig } from '../src/config/index.js';
import { HttpClient, TokenBucket } from '../src/core/http.js';
import { DexScreenerClient } from '../src/ingest/market/dexscreener.js';
import { GeckoTerminalClient } from '../src/ingest/market/geckoterminal.js';
import { BirdeyeClient } from '../src/ingest/market/birdeye.js';
import { SolanaRpc } from '../src/ingest/onchain/rpc.js';
import { SolanaWsClient } from '../src/ingest/onchain/wsClient.js';
import { PROGRAM_IDS } from '../src/ingest/onchain/programs.js';
import { decodePumpLogs } from '../src/ingest/onchain/pumpfun.js';
import { RedditClient } from '../src/ingest/social/reddit.js';
import { logger } from '../src/core/logger.js';
import { GmgnClient } from '../src/safety/gmgn.js';
import { JupiterSellSim } from '../src/safety/jupiter.js';
import { RugcheckClient } from '../src/safety/rugcheck.js';
import { fetchMintInfo } from '../src/safety/mintInfo.js';
import { TelegramBot } from '../src/alerts/telegram.js';

const cfg = loadConfig();
const http = () => new HttpClient(new TokenBucket(1, 1));
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let failures = 0;

async function check(name: string, fn: () => Promise<string>) {
  try {
    console.log(`✔ ${name}: ${await fn()}`);
  } catch (err) {
    failures++;
    console.log(`✘ ${name}: ${String(err)}`);
  }
}

await check('DexScreener tokens/v1', async () => {
  const s = (await new DexScreenerClient(http()).snapshots([BONK])).get(BONK);
  if (!s) throw new Error('no pair returned');
  return `price=${s.priceUsd} liq=${s.liquidityUsd} buys.h1=${s.buys.h1} socials=${s.socials.length}`;
});
await check('DexScreener trending feeds', async () => `${(await new DexScreenerClient(http()).trendingMints()).length} solana mints`);
await check('GeckoTerminal new_pools', async () => {
  const p = await new GeckoTerminalClient(http()).newPools();
  return `${p.length} pools, first=${p[0]?.mint} uniqueBuyers.h1=${p[0]?.uniqueBuyers?.h1}`;
});
if (cfg.env.BIRDEYE_API_KEY) {
  await check('Birdeye overview', async () => JSON.stringify(await new BirdeyeClient(http(), cfg.env.BIRDEYE_API_KEY!).overview(BONK)));
}
if (cfg.rpcUrl) {
  const rpc = new SolanaRpc(cfg.rpcUrl, http());
  await check('RPC getTokenSupply', async () => String((await rpc.getTokenSupply(BONK)).amount));
  await check('RPC getTokenLargestAccounts', async () => `${(await rpc.getTokenLargestAccounts(BONK)).length} accounts`);
  if (cfg.env.HELIUS_API_KEY) await check('Helius DAS getTokenAccounts', async () => `${(await rpc.dasTokenAccounts(BONK, 1, 10)).token_accounts.length} rows`);
}
if (cfg.wsUrl) {
  await check('WS logsSubscribe pump.fun (15s)', () =>
    new Promise((resolve, reject) => {
      const ws = new SolanaWsClient({ url: cfg.wsUrl!, logger });
      let notes = 0;
      const kinds: Record<string, number> = {};
      ws.start();
      ws.onLogs(PROGRAM_IDS.pumpfun, (n) => {
        notes++;
        for (const e of decodePumpLogs(n, PROGRAM_IDS.pumpfun)) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
      });
      setTimeout(() => {
        ws.stop();
        if (!notes) reject(new Error('no notifications'));
        else if (!Object.keys(kinds).length) reject(new Error(`${notes} notifications but 0 decoded events — IDL changed?`));
        else resolve(`${notes} notifications, decoded ${JSON.stringify(kinds)}`);
      }, 15_000);
    }),
  );
}
if (cfg.env.GMGN_API_KEY) {
  await check('GMGN token info + security', async () => {
    const g = await new GmgnClient(new HttpClient(new TokenBucket(2, 2)), cfg.env.GMGN_API_KEY!).facts(BONK);
    return `top10=${g.top10Pct}% bundler=${g.bundlerPct}% insiders=${g.insiderPct}% phishing=${g.phishingPct}% rug=${g.rugRatio} devMigrated=${g.devMigrated} mintRenounced=${g.mintRenounced}`;
  });
}
await check('Jupiter sell simulation (0.1 SOL)', async () => {
  const r = await new JupiterSellSim(http(), cfg.env.JUPITER_API_KEY).simulate(BONK, 0.1);
  if (!r.routable) throw new Error(r.error ?? 'no route');
  return `round-trip loss ${r.roundTripLossPct}% impact ${r.sellPriceImpactPct}%`;
});
if (cfg.env.ENABLE_RUGCHECK) await check('RugCheck summary', async () => JSON.stringify(await new RugcheckClient(http()).summary(BONK)));
if (cfg.rpcUrl) await check('RPC mint info', async () => JSON.stringify(await fetchMintInfo(new SolanaRpc(cfg.rpcUrl!, http()), BONK), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
if (cfg.env.TELEGRAM_BOT_TOKEN && cfg.env.TELEGRAM_ALERT_CHAT_ID) {
  await check('Telegram bot can post to the alert chat', async () => {
    const bot = new TelegramBot(http(), cfg.env.TELEGRAM_BOT_TOKEN!, logger, 0);
    const id = await bot.send(cfg.env.TELEGRAM_ALERT_CHAT_ID!, '✅ memecoin-scanner smoke test', { gmgnMint: BONK });
    if (!id) throw new Error('send failed — is the bot a member/admin of the chat?');
    return `message ${id}`;
  });
}
if (cfg.env.REDDIT_CLIENT_ID && cfg.env.REDDIT_CLIENT_SECRET && cfg.env.REDDIT_USER_AGENT) {
  await check('Reddit r/solana/new', async () => {
    const r = new RedditClient(http(), {
      clientId: cfg.env.REDDIT_CLIENT_ID!,
      clientSecret: cfg.env.REDDIT_CLIENT_SECRET!,
      userAgent: cfg.env.REDDIT_USER_AGENT!,
    });
    return `${(await r.newPosts('solana', 25)).length} posts with token references`;
  });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
