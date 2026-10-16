import { EventEmitter } from 'node:events';
import type {
  MarketSnapshot,
  PoolCreated,
  PumpComplete,
  PumpMigrated,
  PumpTrade,
  SocialMention,
  TokenCreated,
  WalletTrade,
  HolderStats,
  BondingCurveState,
} from './types.js';

export interface BusEvents {
  'token.created': TokenCreated;
  'pool.created': PoolCreated;
  'pumpfun.trade': PumpTrade;
  'pumpfun.complete': PumpComplete;
  'pumpfun.migrated': PumpMigrated;
  'pumpfun.curve': BondingCurveState;
  'market.snapshot': MarketSnapshot;
  'holders.snapshot': HolderStats;
  'social.mention': SocialMention;
  'wallet.trade': WalletTrade;
  /** Discovery hint from trending feeds: a mint worth tracking. */
  'token.discovered': { mint: string; source: string; ts: number };
}

type Handler<T> = (payload: T) => void;

/** Typed in-process event bus. Handler errors are isolated so one bad consumer can't stop ingestion. */
export class EventBus {
  private ee = new EventEmitter();
  constructor(private onError: (event: string, err: unknown) => void = () => {}) {
    this.ee.setMaxListeners(100);
  }

  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): () => void {
    const wrapped = (p: BusEvents[K]) => {
      try {
        handler(p);
      } catch (err) {
        this.onError(event, err);
      }
    };
    this.ee.on(event, wrapped);
    return () => this.ee.off(event, wrapped);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.ee.emit(event, payload);
  }
}
