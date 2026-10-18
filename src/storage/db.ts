import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Signal, SignalUpdate } from '../strategy/types.js';
import type { ClosedOutcome } from '../strategy/positions.js';
import type {
  HolderStats,
  MarketSnapshot,
  PoolCreated,
  PumpTrade,
  SocialMention,
  TokenCreated,
  WalletTrade,
  BondingCurveState,
} from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  name TEXT, symbol TEXT, uri TEXT,
  creator TEXT, bonding_curve TEXT,
  venue TEXT,                 -- where we first saw it
  first_seen_ms INTEGER NOT NULL,
  created_ms INTEGER,         -- on-chain creation time when known
  created_sig TEXT,
  discovered_via TEXT,        -- onchain | dexscreener | gecko | social | wallet
  complete_ms INTEGER,        -- pump.fun curve completed
  migrated_ms INTEGER,
  migrated_pool TEXT
);
CREATE TABLE IF NOT EXISTS pools (
  signature TEXT PRIMARY KEY,
  venue TEXT NOT NULL, base_mint TEXT NOT NULL, quote_mint TEXT NOT NULL,
  pool TEXT, slot INTEGER, ts_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pools_base ON pools(base_mint);
CREATE TABLE IF NOT EXISTS pump_trades (
  signature TEXT NOT NULL, mint TEXT NOT NULL, user TEXT NOT NULL,
  is_buy INTEGER NOT NULL, sol_lamports TEXT NOT NULL, token_amount TEXT NOT NULL,
  v_sol TEXT, v_token TEXT, slot INTEGER, ts_ms INTEGER NOT NULL,
  PRIMARY KEY (signature, mint, user, is_buy, token_amount)
);
CREATE INDEX IF NOT EXISTS pump_trades_mint_ts ON pump_trades(mint, ts_ms);
CREATE TABLE IF NOT EXISTS curve_snapshots (
  mint TEXT NOT NULL, ts_ms INTEGER NOT NULL, progress REAL, price_sol REAL,
  real_sol TEXT, complete INTEGER, PRIMARY KEY (mint, ts_ms)
);
CREATE TABLE IF NOT EXISTS market_snapshots (
  mint TEXT NOT NULL, ts_ms INTEGER NOT NULL, source TEXT NOT NULL,
  pair TEXT, dex TEXT, price_usd REAL, liquidity_usd REAL, fdv_usd REAL, mcap_usd REAL,
  vol_m5 REAL, vol_h1 REAL, buys_m5 INTEGER, sells_m5 INTEGER, buys_h1 INTEGER, sells_h1 INTEGER,
  chg_m5 REAL, chg_h1 REAL, pair_created_ms INTEGER, raw_json TEXT,
  PRIMARY KEY (mint, ts_ms, source)
);
CREATE TABLE IF NOT EXISTS holder_snapshots (
  mint TEXT NOT NULL, ts_ms INTEGER NOT NULL, holder_count INTEGER, count_is_lower_bound INTEGER,
  top_json TEXT, PRIMARY KEY (mint, ts_ms)
);
CREATE TABLE IF NOT EXISTS mentions (
  source TEXT NOT NULL, id TEXT NOT NULL, author TEXT, channel TEXT, text TEXT, url TEXT,
  mints TEXT, tickers TEXT, is_kol INTEGER, ts_ms INTEGER NOT NULL,
  PRIMARY KEY (source, id)
);
CREATE INDEX IF NOT EXISTS mentions_ts ON mentions(ts_ms);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, mint TEXT NOT NULL, symbol TEXT, mode TEXT NOT NULL, score INTEGER NOT NULL,
  coverage REAL, ts_ms INTEGER NOT NULL, entry_price_sol REAL, entry_mcap_usd REAL,
  age_sec REAL, curve_progress REAL, features_json TEXT, facts_json TEXT, filters_json TEXT,
  -- outcome (written once the 24h tracking window ends; no lookahead)
  p1m REAL, p5m REAL, p15m REAL, p1h REAL, p24h REAL,
  max_multiple REAL, max_drawdown_pct REAL, rugged INTEGER, paper_pnl_pct REAL, closed_ms INTEGER, outcome_ms INTEGER
);
CREATE INDEX IF NOT EXISTS signals_ts ON signals(ts_ms);
CREATE TABLE IF NOT EXISTS signal_prices (
  signal_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, price_sol REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS signal_prices_id ON signal_prices(signal_id, ts_ms);
CREATE TABLE IF NOT EXISTS signal_updates (
  signal_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, sell_pct REAL, remaining_pct REAL,
  price_sol REAL, multiple REAL, pnl_pct REAL, reason TEXT
);
CREATE TABLE IF NOT EXISTS wallet_trades (
  signature TEXT NOT NULL, wallet TEXT NOT NULL, mint TEXT NOT NULL, side TEXT NOT NULL,
  token_delta TEXT, sol_delta TEXT, slot INTEGER, ts_ms INTEGER NOT NULL,
  PRIMARY KEY (signature, wallet, mint)
);
`;

const big = (v: bigint | undefined) => (v === undefined ? null : v.toString());

export class Store {
  readonly db: Database.Database;
  private stmts;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.migrate();
    const p = (sql: string) => this.db.prepare(sql);
    this.stmts = {
      upsertToken: p(`INSERT INTO tokens (mint,name,symbol,uri,creator,bonding_curve,venue,first_seen_ms,created_ms,created_sig,discovered_via)
        VALUES (@mint,@name,@symbol,@uri,@creator,@bondingCurve,@venue,@firstSeen,@created,@sig,@via)
        ON CONFLICT(mint) DO UPDATE SET
          name=COALESCE(tokens.name,excluded.name), symbol=COALESCE(tokens.symbol,excluded.symbol),
          uri=COALESCE(tokens.uri,excluded.uri), creator=COALESCE(tokens.creator,excluded.creator),
          bonding_curve=COALESCE(tokens.bonding_curve,excluded.bonding_curve),
          created_ms=COALESCE(tokens.created_ms,excluded.created_ms),
          created_sig=COALESCE(tokens.created_sig,excluded.created_sig)`),
      complete: p(`UPDATE tokens SET complete_ms=COALESCE(complete_ms,?) WHERE mint=?`),
      migrated: p(`UPDATE tokens SET migrated_ms=COALESCE(migrated_ms,?), migrated_pool=COALESCE(migrated_pool,?) WHERE mint=?`),
      pool: p(`INSERT OR IGNORE INTO pools VALUES (?,?,?,?,?,?,?)`),
      trade: p(`INSERT OR IGNORE INTO pump_trades VALUES (?,?,?,?,?,?,?,?,?,?)`),
      curve: p(`INSERT OR REPLACE INTO curve_snapshots VALUES (?,?,?,?,?,?)`),
      market: p(`INSERT OR REPLACE INTO market_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      holders: p(`INSERT OR REPLACE INTO holder_snapshots VALUES (?,?,?,?,?)`),
      mention: p(`INSERT OR IGNORE INTO mentions VALUES (?,?,?,?,?,?,?,?,?,?)`),
      wallet: p(`INSERT OR IGNORE INTO wallet_trades VALUES (?,?,?,?,?,?,?,?)`),
      getToken: p(`SELECT * FROM tokens WHERE mint=?`),
      signal: p(`INSERT OR IGNORE INTO signals (id,mint,symbol,mode,score,coverage,ts_ms,entry_price_sol,entry_mcap_usd,age_sec,curve_progress,features_json,facts_json,filters_json,shadow,reject_ids,max_entry_price_sol)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      price: p(`INSERT INTO signal_prices VALUES (?,?,?)`),
      update: p(`INSERT INTO signal_updates VALUES (?,?,?,?,?,?,?,?,?)`),
      outcome: p(`UPDATE signals SET p1m=?,p5m=?,p15m=?,p1h=?,p24h=?,max_multiple=?,max_drawdown_pct=?,rugged=?,paper_pnl_pct=?,closed_ms=?,outcome_ms=?,emergency_ms=?,emergency_reason=? WHERE id=?`),
    };
  }

  upsertToken(t: Partial<TokenCreated> & { mint: string }, via: string, firstSeen = Date.now()) {
    this.stmts.upsertToken.run({
      mint: t.mint,
      name: t.name ?? null,
      symbol: t.symbol ?? null,
      uri: t.uri ?? null,
      creator: t.creator ?? null,
      bondingCurve: t.bondingCurve ?? null,
      venue: t.venue ?? null,
      firstSeen,
      created: t.ts ?? null,
      sig: t.signature ?? null,
      via,
    });
  }
  markComplete(mint: string, ts: number) {
    this.stmts.complete.run(ts, mint);
  }
  markMigrated(mint: string, ts: number, pool?: string) {
    this.stmts.migrated.run(ts, pool ?? null, mint);
  }
  insertPool(p: PoolCreated) {
    this.stmts.pool.run(p.signature, p.venue, p.baseMint, p.quoteMint, p.pool ?? null, p.slot, p.ts);
  }
  insertTrade(t: PumpTrade) {
    this.stmts.trade.run(
      t.signature, t.mint, t.user, t.isBuy ? 1 : 0, big(t.solAmount), big(t.tokenAmount),
      big(t.virtualSolReserves), big(t.virtualTokenReserves), t.slot, t.ts,
    );
  }
  insertCurve(c: BondingCurveState, ts = Date.now()) {
    this.stmts.curve.run(c.mint, ts, c.progress, c.priceSol, big(c.realSolReserves), c.complete ? 1 : 0);
  }
  insertMarket(s: MarketSnapshot) {
    this.stmts.market.run(
      s.mint, s.ts, s.source, s.pairAddress, s.dexId, s.priceUsd, s.liquidityUsd, s.fdvUsd, s.marketCapUsd,
      s.volumeUsd.m5, s.volumeUsd.h1, s.buys.m5, s.sells.m5, s.buys.h1, s.sells.h1,
      s.priceChangePct.m5, s.priceChangePct.h1, s.pairCreatedAt, JSON.stringify(s),
    );
  }
  insertHolders(h: HolderStats) {
    this.stmts.holders.run(
      h.mint, h.ts, h.holderCount, h.holderCountIsLowerBound ? 1 : 0,
      JSON.stringify(h.top.map((t) => ({ ...t, amount: t.amount.toString() }))),
    );
  }
  insertMention(m: SocialMention) {
    this.stmts.mention.run(
      m.source, m.id, m.author, m.channel, m.text, m.url ?? null,
      JSON.stringify(m.mints), JSON.stringify(m.tickers), m.isKol ? 1 : 0, m.ts,
    );
  }
  insertWalletTrade(t: WalletTrade) {
    this.stmts.wallet.run(t.signature, t.wallet, t.mint, t.side, big(t.tokenDelta), big(t.solDeltaLamports), t.slot, t.ts);
  }
  /** Additive column migrations for databases created by older versions. */
  private migrate() {
    const cols = new Set((this.db.prepare('PRAGMA table_info(signals)').all() as { name: string }[]).map((c) => c.name));
    const add: [string, string][] = [
      ['shadow', 'INTEGER DEFAULT 0'],
      ['reject_ids', 'TEXT'],
      ['emergency_ms', 'INTEGER'],
      ['emergency_reason', 'TEXT'],
      ['max_entry_price_sol', 'REAL'],
    ];
    for (const [name, type] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE signals ADD COLUMN ${name} ${type}`);
  }

  insertSignal(s: Signal) {
    const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    this.stmts.signal.run(
      s.id, s.mint, s.facts.symbol ?? null, s.mode, s.score.score, s.score.coverage, s.ts, s.plan.entryPrice,
      s.facts.mcapUsd, s.facts.ageSec, s.facts.curveProgress, JSON.stringify(s.score.features),
      JSON.stringify(s.facts, replacer), JSON.stringify(s.filters.results),
      s.shadow ? 1 : 0, s.rejectIds?.length ? JSON.stringify(s.rejectIds) : null, s.plan.maxEntryPrice,
    );
  }
  insertSignalPrices(rows: { id: string; ts: number; price: number }[]) {
    if (!rows.length) return;
    this.db.transaction(() => rows.forEach((r) => this.stmts.price.run(r.id, r.ts, r.price)))();
  }
  insertSignalUpdate(u: SignalUpdate) {
    this.stmts.update.run(u.signalId, u.ts, u.kind, u.sellPct, u.remainingPct, u.price, u.multiple, u.pnlPct, u.reason);
  }
  writeOutcome(o: ClosedOutcome, ts = Date.now()) {
    const c = o.checkpoints;
    this.stmts.outcome.run(
      c[1] ?? null, c[5] ?? null, c[15] ?? null, c[60] ?? null, c[1440] ?? null,
      o.maxMultiple, o.maxDrawdownPct, o.rugged ? 1 : 0, o.pnlPct, o.closedTs, ts, o.emergencyTs, o.emergencyReason, o.signalId,
    );
  }
  getToken(mint: string): Record<string, unknown> | undefined {
    return this.stmts.getToken.get(mint) as Record<string, unknown> | undefined;
  }
  count(table: string): number {
    if (!/^\w+$/.test(table)) throw new Error('bad table');
    return (this.db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
  }
  close() {
    this.db.close();
  }
}
