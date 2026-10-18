/**
 * Learn better settings from logged results (live + silent shadow signals).
 * Usage: npm run tune            → prints the walk-forward report
 *        npm run tune -- --write → also writes tuned.json next to the database when it's a real improvement
 * Nothing is applied automatically: to use tuned settings point CONFIG_PATH at that file.
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { walkForward, type TuneSignal } from '../src/backtest/tune.js';

const cfg = loadConfig();
const db = new Database(cfg.env.DB_PATH, { readonly: true });
const rows = db
  .prepare(
    `SELECT id, ts_ms, mode, score, shadow, entry_price_sol, emergency_ms, reject_ids, paper_pnl_pct, max_multiple, rugged
     FROM signals WHERE outcome_ms IS NOT NULL AND entry_price_sol > 0`,
  )
  .all() as {
  id: string; ts_ms: number; mode: 'SNIPE' | 'SCALP'; score: number; shadow: number; entry_price_sol: number;
  emergency_ms: number | null; reject_ids: string | null; paper_pnl_pct: number | null; max_multiple: number | null; rugged: number | null;
}[];
const pathStmt = db.prepare('SELECT ts_ms AS ts, price_sol AS price FROM signal_prices WHERE signal_id = ? ORDER BY ts_ms');

// 1) What each safety filter is worth: outcomes of the rejects we followed silently.
const rejects = rows.filter((r) => r.reject_ids);
if (rejects.length) {
  const by = new Map<string, typeof rejects>();
  for (const r of rejects) for (const id of JSON.parse(r.reject_ids!) as string[]) by.set(id, [...(by.get(id) ?? []), r]);
  console.log('What each filter saved you (sampled rejected coins, followed silently):');
  console.log('filter'.padEnd(20), '   n   rugged  reached 2x  avg P&L if traded');
  for (const [id, rs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
    const pn = rs.map((r) => r.paper_pnl_pct).filter((v): v is number => v !== null);
    const avg = pn.length ? pn.reduce((a, b) => a + b, 0) / pn.length : 0;
    console.log(
      id.padEnd(20),
      String(rs.length).padStart(4),
      `${Math.round((rs.filter((r) => r.rugged === 1).length / rs.length) * 100)}%`.padStart(8),
      `${Math.round((rs.filter((r) => (r.max_multiple ?? 0) >= 2).length / rs.length) * 100)}%`.padStart(11),
      `${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`.padStart(18),
    );
  }
  console.log('→ A filter whose rejects mostly rugged is earning its keep. One whose rejects would have been\n  profitable may be too strict — loosen it in config/default.json, then keep watching.\n');
}

// 2) Walk-forward tuning on safe signals (live + near-miss shadows).
const signals: TuneSignal[] = rows
  .filter((r) => !r.reject_ids)
  .map((r) => ({
    id: r.id,
    ts: r.ts_ms,
    mode: r.mode,
    score: r.score,
    shadow: r.shadow === 1,
    entryPrice: r.entry_price_sol,
    emergencyTs: r.emergency_ms,
    path: pathStmt.all(r.id) as { ts: number; price: number }[],
  }))
  .filter((s) => s.path.length > 1);

const e = cfg.settings.strategy.exit;
const current = {
  exit: { stopLossPct: e.stopLossPct, tp1Multiple: e.tp1Multiple, tp1SellPct: e.tp1SellPct, trailingStopPct: e.trailingStopPct, timeStopMin: e.timeStopMin },
  minScore: { SNIPE: cfg.settings.scoring.minScoreSnipe, SCALP: cfg.settings.scoring.minScoreScalp },
};
console.log(`Tuning on ${signals.length} finished signals (${signals.filter((s) => s.shadow).length} silent near-misses)…`);
const r = walkForward(signals, cfg.settings.strategy, current);
const f = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
for (const [i, fold] of r.folds.entries()) {
  console.log(
    `Window ${i + 1}: learned on ${fold.trainN}, tested on next ${fold.testN} → tuned ${f(fold.testMean)}/trade (${fold.testTrades} trades) vs current ${f(fold.baselineMean)}/trade (${fold.baselineTrades})`,
  );
}
console.log(`\n${r.recommend ? '✅' : '⏸'} ${r.reason}`);
if (r.final) {
  const x = r.final;
  console.log(
    `Best settings on all data: stop −${x.exit.stopLossPct}%, TP1 ${x.exit.tp1Multiple}x sell ${x.exit.tp1SellPct}%, trail ${x.exit.trailingStopPct}%, time stop ${x.exit.timeStopMin}m, min score SNIPE ${x.minScore.SNIPE} / SCALP ${x.minScore.SCALP}`,
  );
}
if (r.recommend && r.final && process.argv.includes('--write')) {
  const s = cfg.settings;
  const tuned = {
    ...s,
    scoring: { ...s.scoring, minScoreSnipe: r.final.minScore.SNIPE, minScoreScalp: r.final.minScore.SCALP },
    strategy: { ...s.strategy, exit: { ...s.strategy.exit, ...r.final.exit, tp2Multiple: Math.max(r.final.exit.tp1Multiple * 1.5, s.strategy.exit.tp2Multiple) } },
    alerts: { ...s.alerts, minScore: Math.min(r.final.minScore.SNIPE, r.final.minScore.SCALP) },
  };
  // Next to the database = on the persistent volume, so it survives redeploys.
  const out = join(dirname(cfg.env.DB_PATH), 'tuned.json');
  writeFileSync(out, JSON.stringify(tuned, null, 2) + '\n');
  console.log(`Wrote ${out}. To use it: set CONFIG_PATH=${out} and restart.`);
}
