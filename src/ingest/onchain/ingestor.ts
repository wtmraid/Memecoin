import type { EventBus } from '../../core/bus.js';
import type { Logger } from '../../core/logger.js';
import { SeenSet } from '../../core/lru.js';
import type { LogNotification, Venue } from '../../core/types.js';
import { decodePumpLogs } from './pumpfun.js';
import { buildPoolCreated, isPoolCreation, type PoolVenue } from './pools.js';
import type { SolanaRpc } from './rpc.js';

/** Anything that can deliver program logs: standard WS today, LaserStream/gRPC later. */
export interface LogSource {
  onLogs(address: string, cb: (n: LogNotification) => void): () => void;
}

export interface OnchainOptions {
  programs: Record<Venue, string>;
  venues: Venue[];
  emitTrades: boolean;
  poolTxFetchDelayMs: number;
}

export interface OnchainStats {
  notifications: number;
  pumpEvents: number;
  poolCandidates: number;
  poolsEmitted: number;
  poolTxMissing: number;
  poolPairUnresolved: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Turns raw program logs into typed bus events. */
export class OnchainIngestor {
  private seen = new SeenSet();
  private unsubs: (() => void)[] = [];
  readonly stats: OnchainStats = {
    notifications: 0,
    pumpEvents: 0,
    poolCandidates: 0,
    poolsEmitted: 0,
    poolTxMissing: 0,
    poolPairUnresolved: 0,
  };

  constructor(
    private source: LogSource,
    private rpc: SolanaRpc,
    private bus: EventBus,
    private log: Logger,
    private opts: OnchainOptions,
  ) {}

  start() {
    for (const venue of this.opts.venues) {
      const programId = this.opts.programs[venue];
      if (venue === 'pumpfun') {
        this.unsubs.push(this.source.onLogs(programId, (n) => this.handlePump(n, programId)));
      } else {
        this.unsubs.push(this.source.onLogs(programId, (n) => void this.handlePool(n, venue, programId)));
      }
      this.log.info({ venue, programId }, 'subscribed to program logs');
    }
  }

  stop() {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
  }

  handlePump(n: LogNotification, programId: string) {
    this.stats.notifications++;
    for (const ev of decodePumpLogs(n, programId)) {
      this.stats.pumpEvents++;
      switch (ev.kind) {
        case 'create':
          if (this.seen.add(`create:${ev.data.mint}`)) this.bus.emit('token.created', ev.data);
          break;
        case 'trade':
          if (this.opts.emitTrades) this.bus.emit('pumpfun.trade', ev.data);
          break;
        case 'complete':
          if (this.seen.add(`complete:${ev.data.mint}`)) this.bus.emit('pumpfun.complete', ev.data);
          break;
        case 'migration':
          if (this.seen.add(`migrate:${ev.data.mint}`)) this.bus.emit('pumpfun.migrated', ev.data);
          break;
      }
    }
  }

  async handlePool(n: LogNotification, venue: PoolVenue, programId: string) {
    this.stats.notifications++;
    if (!isPoolCreation(n, venue, programId)) return;
    if (!this.seen.add(`pool:${n.signature}`)) return;
    this.stats.poolCandidates++;
    try {
      await sleep(this.opts.poolTxFetchDelayMs);
      let tx = await this.rpc.getTransaction(n.signature);
      if (!tx) {
        await sleep(2000);
        tx = await this.rpc.getTransaction(n.signature);
      }
      if (!tx) {
        this.stats.poolTxMissing++;
        return;
      }
      const ev = buildPoolCreated(venue, n, tx);
      if (!ev) {
        this.stats.poolPairUnresolved++;
        this.log.debug({ venue, sig: n.signature }, 'pool pair unresolved');
        return;
      }
      this.stats.poolsEmitted++;
      this.bus.emit('pool.created', ev);
    } catch (err) {
      this.log.warn({ venue, sig: n.signature, err: String(err) }, 'pool tx fetch failed');
    }
  }
}
