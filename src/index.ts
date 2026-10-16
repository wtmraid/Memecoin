import { loadConfig } from './config/index.js';
import { logger } from './core/logger.js';
import { startApp } from './app.js';

async function main() {
  const cfg = loadConfig();
  logger.info(
    {
      venues: cfg.settings.ingest.venues,
      onchain: cfg.env.ENABLE_ONCHAIN,
      reddit: cfg.env.ENABLE_REDDIT,
      telegram: cfg.env.ENABLE_TELEGRAM,
      x: cfg.env.X_PROVIDER,
      smartWallets: cfg.env.SMART_WALLETS.length,
    },
    'starting scanner (Phase 1: ingestion only — no alerts, no trading)',
  );
  const app = await startApp(cfg, logger);

  // Phase 1 console feed of the most important events.
  app.bus.on('token.created', (t) => logger.info({ mint: t.mint, sym: t.symbol, venue: t.venue }, 'new token'));
  app.bus.on('pool.created', (p) => logger.info({ mint: p.baseMint, venue: p.venue }, 'new pool'));
  app.bus.on('pumpfun.complete', (c) => logger.info({ mint: c.mint }, 'pump.fun curve complete'));
  app.bus.on('pumpfun.migrated', (m) => logger.info({ mint: m.mint, pool: m.pool }, 'migrated to PumpSwap'));
  app.bus.on('wallet.trade', (w) => logger.info({ wallet: w.wallet, mint: w.mint, side: w.side }, 'smart wallet trade'));
  app.bus.on('social.mention', (m) => logger.debug({ src: m.source, mints: m.mints, tickers: m.tickers }, 'mention'));

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, 'fatal');
  process.exit(1);
});
