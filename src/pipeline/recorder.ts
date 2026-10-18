import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { Store } from '../storage/db.js';
import type { TokenRegistry } from './registry.js';

/**
 * Persists bus events to SQLite. Writes are queued and flushed in one transaction
 * every `flushMs` — pump.fun trade bursts would otherwise mean thousands of fsyncs.
 */
export class Recorder {
  private queue: (() => void)[] = [];
  private timers: NodeJS.Timeout[] = [];
  public written = 0;

  constructor(
    private bus: EventBus,
    private store: Store,
    private registry: TokenRegistry,
    private log: Logger,
    private opts: { flushMs: number; tradeRetentionHours: number } = { flushMs: 500, tradeRetentionHours: 48 },
  ) {
    const q = (fn: () => void) => this.queue.push(fn);
    bus.on('token.created', (t) => q(() => store.upsertToken(t, 'onchain')));
    bus.on('pool.created', (p) =>
      q(() => {
        store.upsertToken({ mint: p.baseMint, venue: p.venue, ts: p.ts, signature: p.signature }, 'onchain');
        store.insertPool(p);
      }),
    );
    bus.on('token.discovered', (d) => q(() => store.upsertToken({ mint: d.mint }, d.source, d.ts)));
    bus.on('pumpfun.complete', (c) => q(() => store.markComplete(c.mint, c.ts)));
    bus.on('pumpfun.migrated', (m) =>
      q(() => {
        store.upsertToken({ mint: m.mint }, 'onchain');
        store.markMigrated(m.mint, m.ts, m.pool);
      }),
    );
    // Only trades of tokens we track — the full pump.fun firehose is millions of rows/day.
    bus.on('pumpfun.trade', (t) => registry.tokens.has(t.mint) && q(() => store.insertTrade(t)));
    bus.on('pumpfun.curve', (c) => q(() => store.insertCurve(c)));
    bus.on('market.snapshot', (s) => q(() => store.insertMarket(s)));
    bus.on('holders.snapshot', (h) => q(() => store.insertHolders(h)));
    bus.on('social.mention', (m) =>
      q(() => {
        store.insertMention(m);
        for (const mint of m.mints) store.upsertToken({ mint }, `social:${m.source}`, m.ts);
      }),
    );
    bus.on('signal.buy', (s) => q(() => store.insertSignal(s)));
    bus.on('signal.update', (u) => q(() => store.insertSignalUpdate(u)));
    bus.on('wallet.trade', (w) =>
      q(() => {
        store.insertWalletTrade(w);
        store.upsertToken({ mint: w.mint }, 'wallet', w.ts);
      }),
    );
  }

  flush() {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    try {
      this.store.db.transaction(() => batch.forEach((fn) => fn()))();
      this.written += batch.length;
    } catch (err) {
      this.log.error({ err: String(err), n: batch.length }, 'db flush failed');
    }
  }

  prune(now = Date.now()) {
    const cutoff = now - this.opts.tradeRetentionHours * 3600_000;
    this.store.db.prepare('DELETE FROM pump_trades WHERE ts_ms < ?').run(cutoff);
  }

  start() {
    this.timers.push(setInterval(() => this.flush(), this.opts.flushMs));
    this.timers.push(setInterval(() => this.prune(), 3600_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.flush();
  }
}
