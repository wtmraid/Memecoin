import type { ScoringSettings } from '../config/strategy.js';
import type { TokenFacts } from '../filters/facts.js';

export type FeatureKey = keyof ScoringSettings['weights'];

export interface FeatureScore {
  key: FeatureKey;
  /** 0–1, or null when the inputs are unavailable (excluded from the weighted mean). */
  value: number | null;
  weight: number;
  note: string;
}

export interface ScoreResult {
  score: number;
  /** Share of total weight that had data, 0–1. Low coverage = less trustworthy score. */
  coverage: number;
  features: FeatureScore[];
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
/** Linear map: `lo` → 0, `hi` → 1. */
const lerp = (x: number, lo: number, hi: number) => clamp((x - lo) / (hi - lo));

/** Each feature: pure function of facts → [value, explanation]. */
const FEATURES: Record<FeatureKey, (f: TokenFacts, s: ScoringSettings) => [number | null, string]> = {
  buyPressure: (f) => {
    const b = f.momentum.buys5m;
    const s = f.momentum.sells5m;
    if (b === null || s === null || b + s === 0) return [null, 'no 5m trades'];
    const r = b / (b + s);
    return [lerp(r, 0.5, 0.75), `${Math.round(r * 100)}% buys (5m)`];
  },
  buyerVelocity: (f, s) => {
    const u = f.momentum.uniqueBuyers5m;
    return u === null ? [null, 'n/a'] : [clamp(u / s.buyerVelocityTarget5m), `${u} unique buyers / 5m`];
  },
  volumeMomentum: (f) => {
    const v = f.momentum.volume5mUsd;
    const avg = f.momentum.volumeAvg5mUsd;
    if (v === null) return [null, 'n/a'];
    if (!avg) return [lerp(v, 2_000, 30_000), `$${Math.round(v)} 5m volume`];
    const x = v / avg;
    return [lerp(x, 1, 4), `5m volume ${x.toFixed(1)}x hourly avg`];
  },
  holderGrowth: (f, s) => {
    const h = f.momentum.holdersPerMin;
    return h === null ? [null, 'n/a'] : [clamp(h / s.holdersPerMinTarget), `${h.toFixed(1)} new holders/min`];
  },
  liquidityGrowth: (f) => {
    const g = f.momentum.liquidityGrowth5mPct;
    return g === null ? [null, 'n/a'] : [lerp(g, 0, 50), `${g >= 0 ? '+' : ''}${g.toFixed(0)}% liquidity (5m)`];
  },
  smartMoney: (f) => {
    const n = (f.smartMoney.gmgnSmart ?? 0) + (f.smartMoney.gmgnRenowned ?? 0) * 2 + f.smartMoney.watchedWalletBuys * 2;
    if (f.smartMoney.gmgnSmart === null && f.smartMoney.watchedWalletBuys === 0) return [null, 'n/a'];
    return [clamp(n / 5), `${f.smartMoney.gmgnSmart ?? 0} smart, ${f.smartMoney.gmgnRenowned ?? 0} KOL, ${f.smartMoney.watchedWalletBuys} watched`];
  },
  social: (f) => {
    const s = f.social;
    let v = clamp(s.uniqueAuthors1h / 10) * 0.5 + clamp(s.kolMentions1h / 2) * 0.3 + (f.socialCheck?.hasAny ? 0.2 : 0);
    if (s.mentions1h && s.negativeMentions1h / s.mentions1h > 0.3) v *= 0.3; // "rug"/"scam" chatter
    return [clamp(v), `${s.mentions1h} mentions/1h, ${s.kolMentions1h} KOL/caller${s.negativeMentions1h ? `, ${s.negativeMentions1h} negative` : ''}`];
  },
  distribution: (f) => {
    const parts = [
      f.top10Pct === null ? null : 1 - lerp(f.top10Pct, 15, 35),
      f.bundlerPct === null ? null : 1 - lerp(f.bundlerPct, 0, 25),
      f.insiderPct === null ? null : 1 - lerp(f.insiderPct, 0, 12),
      f.sniperPct === null ? null : 1 - lerp(f.sniperPct, 0, 12),
    ].filter((x): x is number => x !== null);
    return parts.length ? [parts.reduce((a, b) => a + b, 0) / parts.length, 'holder spread'] : [null, 'n/a'];
  },
  devQuality: (f) => {
    if (f.rugRatio === null && f.devGradRate === null) return [null, 'n/a'];
    const rug = f.rugRatio === null ? 0.5 : 1 - lerp(f.rugRatio, 0, 0.1);
    const grad = f.devGradRate === null ? 0.5 : lerp(f.devGradRate, 0, 0.3);
    return [(rug + grad) / 2, `rug ${f.rugRatio === null ? 'n/a' : `${(f.rugRatio * 100).toFixed(0)}%`}, grad ${f.devGradRate === null ? 'n/a' : `${(f.devGradRate * 100).toFixed(0)}%`}`];
  },
};

/** Weighted mean of available features, 0–100. */
export function scoreToken(f: TokenFacts, s: ScoringSettings): ScoreResult {
  const features: FeatureScore[] = (Object.keys(FEATURES) as FeatureKey[]).map((key) => {
    const [value, note] = FEATURES[key](f, s);
    return { key, value, weight: s.weights[key], note };
  });
  const total = features.reduce((a, x) => a + x.weight, 0);
  const avail = features.filter((x) => x.value !== null);
  const wsum = avail.reduce((a, x) => a + x.weight, 0);
  const score = wsum ? (avail.reduce((a, x) => a + x.weight * x.value!, 0) / wsum) * 100 : 0;
  return { score: Math.round(score), coverage: total ? wsum / total : 0, features };
}
