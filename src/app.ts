import { EventBus } from './core/bus.js';
import { HttpClient, TokenBucket } from './core/http.js';
import type { Logger } from './core/logger.js';
import { SeenSet } from './core/lru.js';
import type { AppConfig } from './config/index.js';
import { bondingCurvePda, decodeBondingCurve } from './ingest/onchain/bondingCurve.js';
import { fetchHolderStats } from './ingest/onchain/holders.js';
import { OnchainIngestor } from './ingest/onchain/ingestor.js';
import { resolvePrograms } from './ingest/onchain/programs.js';
import { SolanaRpc } from './ingest/onchain/rpc.js';
import { SolanaWsClient } from './ingest/onchain/wsClient.js';
import { DexScreenerClient } from './ingest/market/dexscreener.js';
import { GeckoTerminalClient } from './ingest/market/geckoterminal.js';
import { RedditClient } from './ingest/social/reddit.js';
import { startTelegram } from './ingest/social/telegram.js';
import { MentionTracker } from './ingest/social/velocity.js';
import { OfficialXProvider, ReadBudget, TwitterApiIoProvider, XMentionSource } from './ingest/social/x.js';
import { SmartWalletWatcher } from './ingest/smartmoney/wallets.js';
import { Recorder } from './pipeline/recorder.js';
import { TokenRegistry } from './pipeline/registry.js';
import { Store } from './storage/db.js';
import { TradeBooks } from './analysis/tradeBook.js';
import { GmgnClient } from './safety/gmgn.js';
import { JupiterSellSim } from './safety/jupiter.js';
import { fetchMintInfo } from './safety/mintInfo.js';
import { RugcheckClient } from './safety/rugcheck.js';
import { Evaluator } from './strategy/evaluator.js';
import { PositionMonitor } from './strategy/positions.js';
import { TelegramBot } from './alerts/telegram.js';
import { AlertService } from './alerts/service.js';

const perMin = (n: number) => new TokenBucket(n / 60, Math.max(1, Math.floor(n / 10)));

export interface App {
  bus: EventBus;
  store: Store;
  registry: TokenRegistry;
  mentions: MentionTracker;
  evaluator: Evaluator | null;
  positions: PositionMonitor | null;
  stop(): Promise<void>;
}

/** Phase 1: start every enabled ingestion source and persist what they see. */
export async function startApp(cfg: AppConfig, log: Logger): Promise<App> {
  const { env, settings } = cfg;
  const s = settings.ingest;
  const bus = new EventBus((event, err) => log.error({ event, err: String(err) }, 'bus handler error'));
  const store = new Store(env.DB_PATH);
  const stops: (() => unknown)[] = [];
  const loops: NodeJS.Timeout[] = [];
  const every = (sec: number, name: string, fn: () => Promise<unknown>) => {
    const run = () => fn().catch((err) => log.warn({ loop: name, err: String(err) }, 'loop error'));
    void run();
    loops.push(setInterval(run, sec * 1000));
  };

  // --- RPC / market clients
  const rpc = cfg.rpcUrl
    ? new SolanaRpc(
        cfg.rpcUrl,
        new HttpClient(new TokenBucket(s.rpcReqPerSec)),
        new HttpClient(new TokenBucket(s.dasReqPerSec, 1)),
      )
    : null;
  const ds = new DexScreenerClient(new HttpClient(perMin(s.dexscreenerReqPerMin)), new HttpClient(perMin(50)));
  const gecko = new GeckoTerminalClient(new HttpClient(perMin(s.geckoReqPerMin)));
  const programs = resolvePrograms(settings.programs);
  const isHelius = !!env.HELIUS_API_KEY && !env.SOLANA_RPC_URL;

  const registry = new TokenRegistry(
    bus,
    {
      marketSnapshots: (mints) => (env.ENABLE_DEXSCREENER ? ds.snapshots(mints) : Promise.resolve(new Map())),
      holderStats: rpc
        ? (mint) => fetchHolderStats(rpc, mint, { maxPages: s.holderCountMaxPages, useDas: isHelius })
        : undefined,
      bondingCurve: rpc
        ? async (mint) => {
            const data = await rpc.getAccountData(bondingCurvePda(mint, programs.pumpfun));
            return data ? decodeBondingCurve(mint, data) : null;
          }
        : undefined,
    },
    log,
    {
      trackMaxAgeSec: s.trackMaxAgeSec,
      maxTrackedTokens: s.maxTrackedTokens,
      marketRefreshSec: s.dexscreenerRefreshSec,
      holdersRefreshSec: s.holdersRefreshSec,
      curveRefreshSec: s.bondingCurveRefreshSec,
      holdersPerCycle: s.holdersPerCycle,
      curveFromTradeThrottleMs: s.curveFromTradeThrottleMs,
    },
  );
  const recorder = new Recorder(bus, store, registry, log, { flushMs: 500, tradeRetentionHours: s.tradeRetentionHours });
  registry.start();
  recorder.start();
  stops.push(() => registry.stop(), () => recorder.stop());

  // --- On-chain streams
  let ws: SolanaWsClient | null = null;
  let onchain: OnchainIngestor | null = null;
  if (env.ENABLE_ONCHAIN || env.ENABLE_SMART_WALLETS) {
    if (!cfg.wsUrl || !rpc) throw new Error('On-chain ingestion needs HELIUS_API_KEY or SOLANA_RPC_URL + SOLANA_WS_URL');
    ws = new SolanaWsClient({ url: cfg.wsUrl, logger: log });
    ws.start();
    stops.push(() => ws!.stop());
  }
  if (env.ENABLE_ONCHAIN && ws && rpc) {
    onchain = new OnchainIngestor(ws, rpc, bus, log, {
      programs,
      venues: s.venues,
      emitTrades: env.ENABLE_PUMPFUN_TRADES,
      poolTxFetchDelayMs: s.poolTxFetchDelayMs,
    });
    onchain.start();
    stops.push(() => onchain!.stop());
  }
  if (env.ENABLE_SMART_WALLETS && ws && rpc) {
    if (!env.SMART_WALLETS.length) log.warn('ENABLE_SMART_WALLETS=true but SMART_WALLETS is empty');
    const w = new SmartWalletWatcher(ws, rpc, bus, log, env.SMART_WALLETS);
    w.start();
    stops.push(() => w.stop());
  }

  // --- Discovery feeds (catch pairs on venues we don't stream, and trending older tokens)
  if (env.ENABLE_GECKOTERMINAL) {
    let flip = false;
    every(settings.ingest.geckoPollSec, 'gecko', async () => {
      flip = !flip;
      const snaps = flip ? await gecko.newPools() : await gecko.trendingPools();
      for (const snap of snaps) {
        bus.emit('token.discovered', { mint: snap.mint, source: flip ? 'gecko:new' : 'gecko:trending', ts: Date.now() });
        bus.emit('market.snapshot', snap);
      }
    });
  }
  if (env.ENABLE_DEXSCREENER) {
    every(settings.ingest.trendingPollSec, 'dexscreener-trending', async () => {
      for (const t of await ds.trendingMints()) bus.emit('token.discovered', { mint: t.mint, source: t.source, ts: Date.now() });
    });
  }

  // --- Social
  const mentions = new MentionTracker();
  const seenMentions = new SeenSet();
  const emitMention = (m: Parameters<MentionTracker['record']>[0]) => {
    if (!seenMentions.add(`${m.source}:${m.id}`)) return;
    mentions.record(m);
    bus.emit('social.mention', m);
  };
  loops.push(setInterval(() => mentions.prune(), 300_000));

  if (env.ENABLE_REDDIT) {
    if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET || !env.REDDIT_USER_AGENT) {
      throw new Error('ENABLE_REDDIT needs REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT');
    }
    const reddit = new RedditClient(new HttpClient(perMin(60)), {
      clientId: env.REDDIT_CLIENT_ID,
      clientSecret: env.REDDIT_CLIENT_SECRET,
      userAgent: env.REDDIT_USER_AGENT,
    });
    every(settings.social.redditPollSec, 'reddit', async () => {
      for (const sub of settings.social.subreddits) (await reddit.newPosts(sub)).forEach(emitMention);
    });
  }

  if (env.X_PROVIDER !== 'off') {
    const http = new HttpClient(perMin(30));
    const provider =
      env.X_PROVIDER === 'official'
        ? new OfficialXProvider(http, required(env.X_BEARER_TOKEN, 'X_BEARER_TOKEN'))
        : new TwitterApiIoProvider(http, required(env.TWITTERAPI_IO_KEY, 'TWITTERAPI_IO_KEY'));
    const x = new XMentionSource(provider, new ReadBudget(settings.social.xMaxReadsPerDay), env.KOL_X_HANDLES);
    if (env.KOL_X_HANDLES.length) {
      every(settings.social.xPollSec, 'x-kols', async () => (await x.pollKols()).forEach(emitMention));
    } else log.warn('X enabled but KOL_X_HANDLES empty — nothing to poll');
  }

  if (env.ENABLE_TELEGRAM) {
    const stopTg = await startTelegram({
      apiId: Number(required(env.TELEGRAM_API_ID, 'TELEGRAM_API_ID')),
      apiHash: required(env.TELEGRAM_API_HASH, 'TELEGRAM_API_HASH'),
      session: required(env.TELEGRAM_SESSION, 'TELEGRAM_SESSION'),
      channels: env.TELEGRAM_CHANNELS,
      kolChannels: env.TELEGRAM_KOL_CHANNELS,
      log,
      onMention: emitMention,
    });
    stops.push(stopTg);
  }

  // --- Phase 2+3: safety filters, scoring, signals, sell recommendations
  let evaluator: Evaluator | null = null;
  let positions: PositionMonitor | null = null;
  if (env.ENABLE_SIGNALS) {
    const books = new TradeBooks();
    bus.on('token.created', (c) => books.onCreate(c));
    bus.on('pumpfun.trade', (t) => books.onTrade(t));
    if (!env.ENABLE_PUMPFUN_TRADES) log.warn('ENABLE_PUMPFUN_TRADES=false: bundler/sniper/dev metrics and SNIPE momentum need pump.fun trades');
    if (!env.GMGN_API_KEY) log.warn('GMGN_API_KEY not set: Core Metrics fall back to on-chain estimates (insiders/phishing/rug ratio unavailable)');
    if (!env.JUPITER_API_KEY) log.warn('JUPITER_API_KEY not set: sell simulation runs keyless at 0.5 rps');

    evaluator = new Evaluator(
      {
        bus,
        registry,
        books,
        mentions,
        log,
        // GMGN free plan: ~5 weight/s, 2 per token (info + security). Stay under it.
        gmgn: env.GMGN_API_KEY ? new GmgnClient(new HttpClient(new TokenBucket(2, 4)), env.GMGN_API_KEY) : undefined,
        mintInfo: rpc ? (m) => fetchMintInfo(rpc, m) : undefined,
        rugcheck: env.ENABLE_RUGCHECK ? new RugcheckClient(new HttpClient(perMin(30))) : undefined,
        sellSim: new JupiterSellSim(new HttpClient(new TokenBucket(env.JUPITER_API_KEY ? 0.9 : 0.45, 1)), env.JUPITER_API_KEY),
        marketSnapshots: (m) => ds.snapshots(m),
      },
      { filters: settings.filters, scoring: settings.scoring, strategy: settings.strategy },
    );
    positions = new PositionMonitor(bus, registry, books, evaluator.sol, evaluator.series, settings.strategy, log, {
      refreshMarket: (m) => ds.snapshots(m),
      onOutcome: (o) => store.writeOutcome(o),
    });
    evaluator.start();
    positions.start();
    stops.push(() => evaluator!.stop(), () => positions!.stop());

    const tg =
      env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALERT_CHAT_ID
        ? { bot: new TelegramBot(new HttpClient(new TokenBucket(5, 5)), env.TELEGRAM_BOT_TOKEN, log), chatId: env.TELEGRAM_ALERT_CHAT_ID }
        : undefined;
    if (!tg) log.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID not set: signals are logged and stored but not sent');
    const alerts = new AlertService(bus, log, {
      telegram: tg,
      discord: env.DISCORD_WEBHOOK_URL ? { http: new HttpClient(new TokenBucket(0.4, 2)), webhookUrl: env.DISCORD_WEBHOOK_URL } : undefined,
      evaluator,
      positions,
      minScore: settings.alerts.minScore,
    });
    alerts.startCommands();
    stops.push(() => tg?.bot.stopPolling());
    bus.on('signal.buy', (sg) => log.info({ mint: sg.mint, sym: sg.facts.symbol, mode: sg.mode, score: sg.score.score }, 'SIGNAL'));
    bus.on('signal.update', (u) => log.info({ mint: u.mint, kind: u.kind, sell: u.sellPct, x: u.multiple.toFixed(2) }, 'signal update'));
  }

  // --- Health line every minute
  loops.push(
    setInterval(() => {
      log.info(
        {
          tracked: registry.tokens.size,
          wsConnected: ws?.connected ?? null,
          wsReconnects: ws?.reconnects ?? 0,
          onchain: onchain?.stats,
          dbWrites: recorder.written,
          mentionKeys: mentions.size,
          evaluator: evaluator?.stats,
          openSignals: positions?.positions.size,
          solUsd: evaluator?.sol.usd ? Math.round(evaluator.sol.usd) : null,
        },
        'health',
      );
    }, 60_000),
  );

  return {
    bus,
    store,
    registry,
    mentions,
    evaluator,
    positions,
    async stop() {
      loops.forEach(clearInterval);
      for (const s of stops.reverse()) await s();
      store.close();
    },
  };
}

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is required for the enabled feature`);
  return v;
}
