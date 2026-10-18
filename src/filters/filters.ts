import type { FilterSettings } from '../config/strategy.js';
import type { TokenFacts } from './facts.js';

export type FilterStatus = 'pass' | 'fail' | 'unknown';

export interface FilterResult {
  id: string;
  label: string;
  status: FilterStatus;
  /** Human-readable measured value, e.g. "31.75%". */
  value?: string;
  /** Why it failed / what was checked. Shown in the alert. */
  reason: string;
}

export interface FilterDef {
  id: string;
  label: string;
  /** Unknown data for a `critical` filter counts as a failure; otherwise it's a warning. */
  critical: boolean;
  /** Can run before the paid/slow deep checks (on-chain book + market data only). */
  cheap: boolean;
  check(f: TokenFacts, c: FilterSettings): Omit<FilterResult, 'id' | 'label'>;
}

const p = (n: number) => `${Math.round(n * 100) / 100}%`;
const unknown = (what: string) => ({ status: 'unknown' as const, reason: `${what} unavailable` });
const max = (value: number | null, limit: number, what: string, src?: string) =>
  value === null
    ? unknown(what)
    : value <= limit
      ? { status: 'pass' as const, value: p(value), reason: `${what} ${p(value)} ≤ ${p(limit)}${src ? ` (${src})` : ''}` }
      : { status: 'fail' as const, value: p(value), reason: `${what} ${p(value)} > ${p(limit)} max${src ? ` (${src})` : ''}` };

/** Ordered cheap → expensive. Each is a pure function of facts + thresholds. */
export const FILTERS: FilterDef[] = [
  {
    id: 'age',
    label: 'Min age',
    critical: false,
    cheap: true,
    check: (f, c) =>
      f.ageSec === null
        ? unknown('age')
        : f.ageSec >= c.minAgeSec
          ? { status: 'pass', value: `${Math.round(f.ageSec)}s`, reason: `age ${Math.round(f.ageSec)}s` }
          : { status: 'fail', value: `${Math.round(f.ageSec)}s`, reason: `too new: ${Math.round(f.ageSec)}s < ${c.minAgeSec}s` },
  },
  {
    id: 'liquidity',
    label: 'Liquidity',
    critical: true,
    cheap: true,
    check: (f, c) => {
      if (f.onCurve) {
        if (f.curveSol === null) return unknown('curve SOL');
        return f.curveSol >= c.minCurveSol
          ? { status: 'pass', value: `${f.curveSol.toFixed(1)} SOL`, reason: `${f.curveSol.toFixed(1)} SOL in curve` }
          : { status: 'fail', value: `${f.curveSol.toFixed(1)} SOL`, reason: `only ${f.curveSol.toFixed(1)} SOL in curve (< ${c.minCurveSol})` };
      }
      if (f.liquidityUsd === null) return unknown('liquidity');
      return f.liquidityUsd >= c.minLiquidityUsd
        ? { status: 'pass', value: `$${Math.round(f.liquidityUsd)}`, reason: `liquidity $${Math.round(f.liquidityUsd)}` }
        : { status: 'fail', value: `$${Math.round(f.liquidityUsd)}`, reason: `liquidity $${Math.round(f.liquidityUsd)} < $${c.minLiquidityUsd}` };
    },
  },
  {
    id: 'dev_holding',
    label: 'Dev holdings',
    critical: false,
    cheap: true,
    check: (f, c) => max(f.devHoldPct, c.maxDevHoldPct, 'dev holds', f.sources.devHoldPct),
  },
  {
    id: 'bundler',
    label: 'Bundler',
    critical: false,
    cheap: true,
    check: (f, c) => max(f.bundlerPct, c.maxBundlerPct, 'bundled supply', f.sources.bundlerPct),
  },
  {
    id: 'sniper',
    label: 'Sniper',
    critical: false,
    cheap: true,
    check: (f, c) => {
      const r = max(f.sniperPct, c.maxSniperPct, 'sniper supply', f.sources.sniperPct);
      if (r.status === 'fail') return r;
      if (f.sniperCount !== null && f.sniperCount > c.maxSniperCount)
        return { status: 'fail', value: String(f.sniperCount), reason: `${f.sniperCount} sniper wallets > ${c.maxSniperCount}` };
      return r.status === 'unknown' && f.sniperCount !== null
        ? { status: 'pass', value: `${f.sniperCount} wallets`, reason: `${f.sniperCount} sniper wallets` }
        : r;
    },
  },
  {
    id: 'top10',
    label: 'Top 10',
    critical: false,
    cheap: true,
    check: (f, c) => max(f.top10Pct, c.maxTop10Pct, 'top 10 hold', f.sources.top10Pct),
  },
  {
    id: 'wash_trading',
    label: 'Wash trading',
    critical: false,
    cheap: true,
    check: (f, c) => {
      if (f.isWashTrading === true) return { status: 'fail', reason: 'GMGN flags wash trading' };
      if (f.txPerTrader !== null && f.txPerTrader > c.maxTxPerTrader)
        return { status: 'fail', value: f.txPerTrader.toFixed(1), reason: `${f.txPerTrader.toFixed(1)} tx per trader (bot churn)` };
      // High volume/liquidity is only fake if few people hold it — busy runners also churn.
      if (f.volToLiq1h !== null && f.volToLiq1h > c.maxVolumeToLiquidity1h && (f.holderCount ?? 0) < 150)
        return { status: 'fail', value: `${f.volToLiq1h.toFixed(1)}x`, reason: `1h volume ${f.volToLiq1h.toFixed(1)}x liquidity with <150 holders` };
      if (f.isWashTrading === null && f.txPerTrader === null && f.volToLiq1h === null) return unknown('volume data');
      return { status: 'pass', reason: 'no wash-trading pattern' };
    },
  },
  {
    id: 'holders',
    label: 'Holders',
    critical: false,
    cheap: true,
    check: (f, c) =>
      f.holderCount === null
        ? unknown('holder count')
        : f.holderCount >= c.minHolders
          ? { status: 'pass', value: String(f.holderCount), reason: `${f.holderCount} holders` }
          : { status: 'fail', value: String(f.holderCount), reason: `${f.holderCount} holders < ${c.minHolders}` },
  },
  {
    id: 'mint_authority',
    label: 'Mint revoked',
    critical: true,
    cheap: false,
    check: (f, c) =>
      !c.requireMintRevoked
        ? { status: 'pass', reason: 'not required' }
        : f.mintRenounced === null
          ? unknown('mint authority')
          : f.mintRenounced
            ? { status: 'pass', reason: 'mint authority revoked' }
            : { status: 'fail', reason: 'dev can still MINT new tokens' },
  },
  {
    id: 'freeze_authority',
    label: 'No freeze',
    critical: true,
    cheap: false,
    check: (f, c) =>
      !c.requireFreezeRevoked
        ? { status: 'pass', reason: 'not required' }
        : f.freezeRenounced === null
          ? unknown('freeze authority')
          : f.freezeRenounced
            ? { status: 'pass', reason: 'freeze authority revoked' }
            : { status: 'fail', reason: 'dev can FREEZE your tokens (honeypot)' },
  },
  {
    id: 'token_extensions',
    label: 'Token-2022 ext.',
    critical: false,
    cheap: false,
    check: (f, c) => {
      if (f.dangerousExtensions === null) return unknown('token extensions');
      if (!c.rejectDangerousExtensions || !f.dangerousExtensions.length) return { status: 'pass', reason: 'no dangerous extensions' };
      return { status: 'fail', value: f.dangerousExtensions.join(','), reason: `dangerous extensions: ${f.dangerousExtensions.join(', ')}` };
    },
  },
  {
    id: 'tax',
    label: 'Taxes',
    critical: false,
    cheap: false,
    check: (f, c) => max(f.taxPct, c.maxTaxPct, 'tax', f.sources.taxPct),
  },
  {
    id: 'lp_locked',
    label: 'LP burned/locked',
    critical: false,
    cheap: false,
    check: (f, c) => {
      if (!f.lp.applies) return { status: 'pass', reason: 'bonding curve — no LP that can be pulled' };
      if (f.lp.burned === true) return { status: 'pass', value: '100%', reason: 'LP burned' };
      if (f.lp.burnedOrLockedPct === null) return unknown('LP lock');
      return f.lp.burnedOrLockedPct >= c.minLpBurnedOrLockedPct
        ? { status: 'pass', value: p(f.lp.burnedOrLockedPct), reason: `LP ${p(f.lp.burnedOrLockedPct)} burned/locked` }
        : { status: 'fail', value: p(f.lp.burnedOrLockedPct), reason: `only ${p(f.lp.burnedOrLockedPct)} of LP burned/locked — can be pulled` };
    },
  },
  {
    id: 'insiders',
    label: 'Insiders',
    critical: false,
    cheap: false,
    check: (f, c) => max(f.insiderPct, c.maxInsiderPct, 'insiders', f.sources.insiderPct),
  },
  {
    id: 'phishing',
    label: 'Phishing wallet',
    critical: false,
    cheap: false,
    check: (f, c) => max(f.phishingPct, c.maxPhishingPct, 'phishing wallets', f.sources.phishingPct),
  },
  {
    id: 'dev_team',
    label: 'Dev team holdings',
    critical: false,
    cheap: false,
    check: (f, c) => max(f.devTeamHoldPct, c.maxDevTeamHoldPct, 'dev team holds', f.sources.devTeamHoldPct),
  },
  {
    id: 'dev_history',
    label: 'Dev history',
    critical: false,
    cheap: false,
    check: (f, c) => {
      if (f.rugRatio !== null && f.rugRatio > c.maxRugRatio)
        return { status: 'fail', value: p(f.rugRatio * 100), reason: `GMGN rug ratio ${p(f.rugRatio * 100)} > ${p(c.maxRugRatio * 100)}` };
      if (f.creatorLaunches24h !== null && f.creatorLaunches24h > c.maxCreatorLaunches24h)
        return { status: 'fail', value: String(f.creatorLaunches24h), reason: `dev launched ${f.creatorLaunches24h} tokens in 24h (serial launcher)` };
      if (f.devLaunches !== null && f.devGradRate !== null && f.devLaunches >= c.serialFarmMinLaunches && f.devGradRate <= c.serialFarmMaxGradRate)
        return {
          status: 'fail',
          value: `${f.devLaunches} launches`,
          reason: `dev farm: ${f.devLaunches} launches, ${p(f.devGradRate * 100)} migrated`,
        };
      if (f.rugRatio === null && f.creatorLaunches24h === null && f.devLaunches === null) return unknown('dev history');
      return { status: 'pass', reason: `rug ratio ${f.rugRatio === null ? 'n/a' : p(f.rugRatio * 100)}, migrated ${f.devMigrated ?? 'n/a'}` };
    },
  },
  {
    id: 'socials',
    label: 'Socials',
    critical: false,
    cheap: false,
    check: (f, c) => {
      if (!f.socialCheck) return unknown('socials');
      if (c.requireSocials && !f.socialCheck.hasAny) return { status: 'fail', reason: 'no X / Telegram / website' };
      if (f.socialCheck.problems.length) return { status: 'fail', reason: f.socialCheck.problems[0]! };
      if (c.rejectRecycledSocials && f.recycledWith.length)
        return { status: 'fail', reason: `socials reused from ${f.recycledWith.length} other token(s) — recycled account` };
      return { status: 'pass', reason: 'socials look original' };
    },
  },
  {
    id: 'rugcheck',
    label: 'RugCheck',
    critical: false,
    cheap: false,
    check: (f, c) => {
      const r = f.rugcheck;
      if (!r) return unknown('RugCheck');
      if (r.dangers.length) return { status: 'fail', value: r.dangers[0], reason: `RugCheck danger: ${r.dangers.join(', ')}` };
      if (r.scoreNormalised !== null && r.scoreNormalised > c.maxRugcheckScore)
        return { status: 'fail', value: String(r.scoreNormalised), reason: `RugCheck risk ${r.scoreNormalised}/100` };
      return { status: 'pass', value: r.scoreNormalised === null ? undefined : String(r.scoreNormalised), reason: 'RugCheck OK' };
    },
  },
  {
    id: 'sell_simulation',
    label: 'Sell test',
    critical: true,
    cheap: false,
    check: (f, c) => {
      if (!c.requireSellSim) return { status: 'pass', reason: 'not required' };
      const s = f.sellSim;
      if (!s) return unknown('sell simulation');
      if (!s.routable) {
        // pump.fun curve tokens use a standard audited program; a missing aggregator route
        // there means "not indexed yet", not a honeypot.
        if (f.onCurve) return { status: 'pass', reason: 'pump.fun curve (standard program)' };
        return { status: 'fail', reason: `cannot sell: ${s.error ?? 'no route'}` };
      }
      return s.roundTripLossPct !== null && s.roundTripLossPct > c.maxSellLossPct
        ? { status: 'fail', value: p(s.roundTripLossPct), reason: `round-trip loss ${p(s.roundTripLossPct)} (hidden tax / thin pool)` }
        : { status: 'pass', value: s.roundTripLossPct === null ? undefined : p(s.roundTripLossPct), reason: 'sell route OK' };
    },
  },
];

export interface FilterReport {
  passed: boolean;
  results: FilterResult[];
  failures: FilterResult[];
  unknowns: FilterResult[];
}

export function runFilters(f: TokenFacts, c: FilterSettings, opts: { cheapOnly?: boolean } = {}): FilterReport {
  const results: FilterResult[] = [];
  for (const def of FILTERS) {
    if (opts.cheapOnly && !def.cheap) continue;
    const r = def.check(f, c);
    // In the cheap pre-gate, unknowns never block — deep checks fill them in.
    const status: FilterStatus = r.status === 'unknown' && def.critical && !opts.cheapOnly ? 'fail' : r.status;
    results.push({ id: def.id, label: def.label, ...r, status, reason: status !== r.status ? `${r.reason} (required)` : r.reason });
  }
  const failures = results.filter((r) => r.status === 'fail');
  return { passed: failures.length === 0, results, failures, unknowns: results.filter((r) => r.status === 'unknown') };
}
