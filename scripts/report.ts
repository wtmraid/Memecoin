/**
 * Performance of logged signals (paper trades with fees/slippage/tips), per mode and
 * score bucket. Only signals whose 24h tracking window has finished are counted.
 * Usage: npm run report [-- --days 7]
 */
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/index.js';
import { groupStats, type OutcomeRow } from '../src/backtest/report.js';

const cfg = loadConfig();
const daysArg = process.argv.indexOf('--days');
const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;
const db = new Database(cfg.env.DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `SELECT mode, score, ts_ms, paper_pnl_pct, max_multiple, max_drawdown_pct, rugged
     FROM signals WHERE outcome_ms IS NOT NULL AND ts_ms > ? AND COALESCE(shadow, 0) = 0 AND paper_pnl_pct IS NOT NULL`,
  )
  .all(Date.now() - days * 86_400_000) as OutcomeRow[];
const pending = (db.prepare('SELECT COUNT(*) c FROM signals WHERE outcome_ms IS NULL AND COALESCE(shadow, 0) = 0').get() as { c: number }).c;

const p = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
const f = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`.padStart(8);
console.log(`Signals with complete 24h outcome (last ${days}d): ${rows.length}   still tracking: ${pending}\n`);
console.log('group'.padEnd(28), '   n  win   avgWin  avgLoss  expect.   maxDD   ≥2x  ≥3x  rug');
for (const { key, stats: s } of groupStats(rows)) {
  console.log(
    key.padEnd(28),
    String(s.n).padStart(4),
    p(s.winRate),
    f(s.avgWinPct),
    f(s.avgLossPct),
    f(s.expectancyPct),
    f(s.maxDrawdownPct),
    p(s.hit2xRate),
    p(s.hit3xRate),
    p(s.rugRate),
  );
}
if (rows.length < 50) console.log('\nFewer than 50 finished signals — numbers are noise until the sample grows. Keep paper trading.');
