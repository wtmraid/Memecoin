export interface OutcomeRow {
  mode: string;
  score: number;
  ts_ms: number;
  paper_pnl_pct: number;
  max_multiple: number | null;
  max_drawdown_pct: number | null;
  rugged: number | null;
}

export interface Stats {
  n: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  /** Mean P&L per trade, %. Positive = the rules make money on this slice. */
  expectancyPct: number;
  /** Worst peak-to-trough of the cumulative P&L curve (equal size per trade), %. */
  maxDrawdownPct: number;
  hit2xRate: number;
  hit3xRate: number;
  rugRate: number;
}

export function computeStats(rows: OutcomeRow[]): Stats {
  const n = rows.length;
  if (!n) return { n: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, expectancyPct: 0, maxDrawdownPct: 0, hit2xRate: 0, hit3xRate: 0, rugRate: 0 };
  const sorted = [...rows].sort((a, b) => a.ts_ms - b.ts_ms);
  const wins = rows.filter((r) => r.paper_pnl_pct > 0);
  const losses = rows.filter((r) => r.paper_pnl_pct <= 0);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  let equity = 0;
  let peak = 0;
  let mdd = 0;
  for (const r of sorted) {
    equity += r.paper_pnl_pct;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, equity - peak);
  }
  return {
    n,
    winRate: wins.length / n,
    avgWinPct: mean(wins.map((r) => r.paper_pnl_pct)),
    avgLossPct: mean(losses.map((r) => r.paper_pnl_pct)),
    expectancyPct: mean(rows.map((r) => r.paper_pnl_pct)),
    maxDrawdownPct: mdd,
    hit2xRate: rows.filter((r) => (r.max_multiple ?? 0) >= 2).length / n,
    hit3xRate: rows.filter((r) => (r.max_multiple ?? 0) >= 3).length / n,
    rugRate: rows.filter((r) => r.rugged === 1).length / n,
  };
}

export const scoreBucket = (s: number) => (s >= 90 ? '90+' : s >= 80 ? '80-89' : s >= 70 ? '70-79' : s >= 60 ? '60-69' : '<60');

export function groupStats(rows: OutcomeRow[]): { key: string; stats: Stats }[] {
  const groups = new Map<string, OutcomeRow[]>();
  const add = (k: string, r: OutcomeRow) => groups.set(k, [...(groups.get(k) ?? []), r]);
  for (const r of rows) {
    add('ALL', r);
    add(`mode=${r.mode}`, r);
    add(`mode=${r.mode} score=${scoreBucket(r.score)}`, r);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rs]) => ({ key, stats: computeStats(rs) }));
}
