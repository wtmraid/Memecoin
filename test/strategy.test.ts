import { describe, expect, it } from 'vitest';
import { ScoringSchema, StrategySchema } from '../src/config/strategy.js';
import { scoreToken } from '../src/scoring/score.js';
import { buildPlan, decideMode } from '../src/strategy/plan.js';
import { applyExits, evaluateExits, type PositionState } from '../src/strategy/exits.js';
import { PaperPosition } from '../src/backtest/paper.js';
import { OutcomeTracker } from '../src/backtest/outcomes.js';
import { computeStats, groupStats, scoreBucket } from '../src/backtest/report.js';
import { cleanFacts } from './factsFixture.js';

const S = StrategySchema.parse({});
const SC = ScoringSchema.parse({});

describe('scoring', () => {
  const hot = cleanFacts({
    momentum: {
      buys2m: 40, sells2m: 10, buys5m: 120, sells5m: 30, uniqueBuyers5m: 70, uniqueBuyersTotal: 150,
      volume5mUsd: 30_000, volumeAvg5mUsd: 6_000, priceChange5mPct: 25, liquidityGrowth5mPct: 60, holdersPerMin: 10,
    },
    smartMoney: { gmgnSmart: 4, gmgnRenowned: 1, watchedWalletBuys: 1 },
    social: { mentions1h: 20, mentions5m: 6, kolMentions1h: 2, uniqueAuthors1h: 12, negativeMentions1h: 0, acceleration: 3 },
  });

  it('strong momentum + clean distribution scores high with full coverage', () => {
    const r = scoreToken(hot, SC);
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect(r.coverage).toBe(1);
  });

  it('is bounded 0–100 and ignores missing features (coverage drops)', () => {
    const r = scoreToken(cleanFacts(), SC);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.coverage).toBeLessThan(1);
  });

  it('rug/scam chatter crushes the social score', () => {
    const neg = { ...hot, social: { ...hot.social, negativeMentions1h: 10 } };
    const a = scoreToken(hot, SC).features.find((f) => f.key === 'social')!.value!;
    const b = scoreToken(neg, SC).features.find((f) => f.key === 'social')!.value!;
    expect(b).toBeLessThan(a * 0.5);
  });

  it('sell-heavy flow scores 0 on buy pressure', () => {
    const f = { ...hot, momentum: { ...hot.momentum, buys5m: 10, sells5m: 40 } };
    expect(scoreToken(f, SC).features.find((x) => x.key === 'buyPressure')!.value).toBe(0);
  });
});

describe('mode detection', () => {
  const m = (o: object) => ({ ...cleanFacts().momentum, buys2m: 30, sells2m: 10, uniqueBuyersTotal: 60, ...o });

  it('SNIPE: young, enough buyers, curve in range, buyers in control', () => {
    expect(decideMode(cleanFacts({ ageSec: 240, curveProgress: 0.3, momentum: m({}) }), S).mode).toBe('SNIPE');
  });
  it('no SNIPE: too few buyers, too close to migration, or sellers in control', () => {
    expect(decideMode(cleanFacts({ ageSec: 240, momentum: m({ uniqueBuyersTotal: 5 }) }), S).reasons[0]).toMatch(/unique buyers/);
    expect(decideMode(cleanFacts({ ageSec: 240, curveProgress: 0.92, momentum: m({}) }), S).reasons.join()).toMatch(/migration/);
    expect(decideMode(cleanFacts({ ageSec: 240, momentum: m({ buys2m: 5, sells2m: 20 }) }), S).reasons.join()).toMatch(/buy\/sell/);
  });
  it('SCALP: volume breakout without a vertical candle', () => {
    const f = cleanFacts({ ageSec: 7200, onCurve: false, liquidityUsd: 50_000, momentum: m({ volume5mUsd: 20_000, volumeAvg5mUsd: 5_000, priceChange5mPct: 12, buys5m: 200, sells5m: 100 }) });
    expect(decideMode(f, S).mode).toBe('SCALP');
    const vertical = { ...f, momentum: { ...f.momentum, priceChange5mPct: 90 } };
    expect(decideMode(vertical, S).reasons.join()).toMatch(/don't chase/);
    const flat = { ...f, momentum: { ...f.momentum, volume5mUsd: 6_000 } };
    expect(decideMode(flat, S).reasons.join()).toMatch(/breakout/);
  });
});

describe('trade plan', () => {
  it('levels follow config and are shown as market cap', () => {
    const p = buildPlan(1e-7, 40_000, S);
    expect(p.maxEntryPrice).toBeCloseTo(1.15e-7);
    expect(p.stopPrice).toBeCloseTo(0.7e-7);
    expect(p.tp1Price).toBeCloseTo(2e-7);
    expect(p.mcap).toMatchObject({ entry: 40_000, tp1: 80_000, tp2: 120_000 });
    expect(p.lines.join('\n')).toMatch(/MC \$80\.0K/);
  });
});

describe('exit rules', () => {
  const base: PositionState = {
    entryPrice: 1, entryTs: 0, peakPrice: 1, remainingPct: 100, tp1Done: false, tp2Done: false, migrationDone: false,
    devTokensAtEntry: 1000n, bundleTokensAtEntry: 5000n,
  };
  const at = (price: number, o: object = {}, p: PositionState = base) => evaluateExits(p, { now: 60_000, price, ...o }, S);

  it('nothing to do in the normal range', () => expect(at(1.3)).toEqual([]));
  it('TP1 at 2x sells 50%, TP2 at 3x sells 25% (both on a gap)', () => {
    expect(at(2.1).map((a) => [a.kind, a.sellPct])).toEqual([['tp1', 50]]);
    expect(at(3.2).map((a) => [a.kind, a.sellPct])).toEqual([['tp1', 50], ['tp2', 25]]);
  });
  it('stop-loss ignores a one-trade wick but fires if price stays below the stop', () => {
    const stop = 0.7;
    expect(at(0.69)).toEqual([]); // just dipped: start the clock, don't sell yet
    const s1 = applyExits({ ...base, stopPrice: stop }, [], 0.69, 0);
    expect(s1.belowStopSince).toBe(0);
    expect(evaluateExits(s1, { now: 5_000, price: 0.68 }, S)).toEqual([]); // 5s < 8s
    expect(evaluateExits(s1, { now: 9_000, price: 0.68 }, S)[0]).toMatchObject({ kind: 'stop_loss', sellPct: 100 });
    const recovered = applyExits(s1, [], 0.75, 3_000); // wick recovered → clock resets
    expect(recovered.belowStopSince).toBeNull();
  });
  it('a crash far below the stop sells instantly', () => {
    expect(at(0.55)[0]).toMatchObject({ kind: 'stop_loss', sellPct: 100 });
  });
  it('trailing stop only after TP1', () => {
    const after = applyExits(base, at(2.5), 2.5); // TP1 done, peak 2.5
    expect(after).toMatchObject({ tp1Done: true, remainingPct: 50, peakPrice: 2.5 });
    expect(evaluateExits(after, { now: 1, price: 1.7 }, S)[0]).toMatchObject({ kind: 'trailing_stop', sellPct: 50 });
    expect(evaluateExits(base, { now: 1, price: 0.8 }, S)).toEqual([]); // −20% before TP1: hold
  });
  it('time stop when it goes nowhere', () => {
    expect(at(1.1, { now: 31 * 60_000 })[0]).toMatchObject({ kind: 'time_stop' });
    expect(at(1.3, { now: 31 * 60_000 })).toEqual([]);
  });
  it('emergency: dev dumps, bundle exodus, liquidity pull, sell wall', () => {
    expect(at(1.5, { devTokens: 700n })[0]).toMatchObject({ kind: 'emergency', sellPct: 100 });
    expect(at(1.5, { bundleTokens: 3000n })[0]!.reason).toMatch(/bundle wallets dumped 40%/);
    expect(at(1.5, { liquidityUsd: 6000, liquidityUsd5mAgo: 10_000 })[0]!.reason).toMatch(/liquidity −40%/);
    const peaked = { ...base, peakPrice: 2 };
    expect(at(1.4, { buys2m: 5, sells2m: 20 }, peaked)[0]!.reason).toMatch(/sell wall/);
    expect(at(1.5, { devTokens: 900n })).toEqual([]); // dev sold 10% < 20%
  });
  it('de-risk into migration when in profit', () => {
    const r = at(1.6, { migrated: true });
    expect(r[0]).toMatchObject({ kind: 'migration', sellPct: 50 });
  });
  it('closed positions produce nothing', () => expect(at(0.1, {}, { ...base, remainingPct: 0 })).toEqual([]));
});

describe('paper fills', () => {
  it('a 2x with 50/25 then trail exit nets less than the gross move after costs', () => {
    const p = new PaperPosition(S.paper);
    p.buy(0, 1);
    p.sell(1, 50, 2, 'tp1');
    p.sell(2, 25, 3, 'tp2');
    p.sell(3, 25, 2.1, 'trail');
    const gross = (0.5 * 2 + 0.25 * 3 + 0.25 * 2.1 - 1) * 100; // +127.5%
    expect(p.pnlPct()).toBeLessThan(gross);
    expect(p.pnlPct()).toBeGreaterThan(gross - 20);
  });
  it('a stop-out loses more than the stop distance (slippage + fees + tips)', () => {
    const p = new PaperPosition(S.paper);
    p.buy(0, 1);
    p.sell(1, 100, 0.7, 'stop');
    expect(p.pnlPct()).toBeLessThan(-30);
  });
});

describe('outcomes + report', () => {
  it('records checkpoints only once their time has passed, and flags rugs', () => {
    const o = new OutcomeTracker(1, 0, [1, 5]);
    o.observe(30_000, 1.5);
    expect(o.checkpoints.size).toBe(0);
    o.observe(61_000, 2);
    o.observe(200_000, 0.15);
    o.observe(301_000, 0.1);
    expect(Object.fromEntries(o.checkpoints)).toEqual({ 1: 2, 5: 0.1 });
    expect(o.maxMultiple).toBe(2);
    expect(o.rugged).toBe(true);
    expect(o.done(301_000)).toBe(true);
  });

  it('computes win rate, expectancy and equity drawdown', () => {
    const rows = [10, -20, 50, -30, 40].map((pnl, i) => ({ mode: 'SNIPE', score: 70 + i * 5, ts_ms: i, paper_pnl_pct: pnl, max_multiple: pnl > 0 ? 2.2 : 0.9, max_drawdown_pct: -10, rugged: pnl === -30 ? 1 : 0 }));
    const s = computeStats(rows);
    expect(s).toMatchObject({ n: 5, winRate: 0.6, expectancyPct: 10, maxDrawdownPct: -30, hit2xRate: 0.6, rugRate: 0.2 });
    expect(s.avgWinPct).toBeCloseTo(33.33, 1);
    expect(groupStats(rows).map((g) => g.key)).toContain('mode=SNIPE score=80-89');
    expect(scoreBucket(91)).toBe('90+');
  });
});
