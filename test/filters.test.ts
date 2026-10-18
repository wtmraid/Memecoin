import { describe, expect, it } from 'vitest';
import { FiltersSchema } from '../src/config/strategy.js';
import type { TokenFacts } from '../src/filters/facts.js';
import { cleanFacts } from './factsFixture.js';
import { FILTERS, runFilters } from '../src/filters/filters.js';

const cfg = FiltersSchema.parse({});

const byId = (f: TokenFacts, id: string, c = cfg) => {
  const def = FILTERS.find((d) => d.id === id)!;
  return def.check(f, c);
};

describe('every filter passes on a clean token', () => {
  for (const def of FILTERS) {
    it(def.id, () => expect(def.check(cleanFacts(), cfg).status).toBe('pass'));
  }
  it('runFilters passes overall', () => expect(runFilters(cleanFacts(), cfg).passed).toBe(true));
});

describe('hard rejects', () => {
  const cases: [string, Partial<TokenFacts>, RegExp][] = [
    ['age', { ageSec: 20 }, /too new/],
    ['liquidity', { curveSol: 2 }, /SOL in curve/],
    ['liquidity', { onCurve: false, liquidityUsd: 4000 }, /liquidity \$4000/],
    ['dev_holding', { devHoldPct: 14 }, /dev holds 14%/],
    ['bundler', { bundlerPct: 31.75 }, /bundled supply 31.75% > 20%/],
    ['sniper', { sniperPct: 15 }, /sniper supply/],
    ['sniper', { sniperPct: null, sniperCount: 40 }, /40 sniper wallets/],
    ['top10', { top10Pct: 45 }, /top 10 hold 45%/],
    ['wash_trading', { isWashTrading: true }, /GMGN flags/],
    ['wash_trading', { txPerTrader: 9 }, /tx per trader/],
    ['wash_trading', { volToLiq1h: 40, holderCount: 60 }, /volume 40.0x liquidity/],
    ['holders', { holderCount: 12 }, /12 holders/],
    ['mint_authority', { mintRenounced: false }, /MINT/],
    ['freeze_authority', { freezeRenounced: false }, /FREEZE/],
    ['token_extensions', { dangerousExtensions: ['permanentDelegate'] }, /permanentDelegate/],
    ['tax', { taxPct: 10 }, /tax 10%/],
    ['lp_locked', { lp: { applies: true, burnedOrLockedPct: 40, burned: false } }, /can be pulled/],
    ['insiders', { insiderPct: 25 }, /insiders 25%/],
    ['phishing', { phishingPct: 18 }, /phishing wallets 18%/],
    ['dev_team', { devTeamHoldPct: 30 }, /dev team holds/],
    ['dev_history', { rugRatio: 0.35 }, /rug ratio 35%/],
    ['dev_history', { creatorLaunches24h: 9 }, /serial launcher/],
    ['dev_history', { devLaunches: 120, devGradRate: 0.01 }, /dev farm/],
    ['socials', { socialCheck: { hasAny: false, keys: [], problems: [] } }, /no X/],
    ['socials', { socialCheck: { hasAny: true, keys: [], problems: ['X link points to a tweet/community, not the project account'] } }, /tweet/],
    ['socials', { recycledWith: ['OtherMint'] }, /recycled/],
    ['rugcheck', { rugcheck: { scoreNormalised: 20, dangers: ['Freeze Authority still enabled'], warnings: [], lpLockedPct: null } }, /danger/],
    ['rugcheck', { rugcheck: { scoreNormalised: 85, dangers: [], warnings: [], lpLockedPct: null } }, /85\/100/],
    ['sell_simulation', { onCurve: false, sellSim: { routable: false, roundTripLossPct: null, sellPriceImpactPct: null, error: 'no route' } }, /cannot sell/],
    ['sell_simulation', { sellSim: { routable: true, roundTripLossPct: 40, sellPriceImpactPct: 2 } }, /hidden tax/],
  ];
  for (const [id, over, re] of cases) {
    it(`${id}: ${re}`, () => {
      const r = byId(cleanFacts(over), id);
      expect(r.status).toBe('fail');
      expect(r.reason).toMatch(re);
    });
  }
});

describe('edge cases', () => {
  it('high volume/liquidity is NOT wash trading when many holders (busy runner)', () => {
    expect(byId(cleanFacts({ volToLiq1h: 40, holderCount: 900 }), 'wash_trading').status).toBe('pass');
  });
  it('pump.fun curve tokens are exempt from LP lock (nothing to pull)', () => {
    expect(byId(cleanFacts({ lp: { applies: false, burnedOrLockedPct: null, burned: null } }), 'lp_locked').reason).toMatch(/bonding curve/);
  });
  it('burned LP passes', () => {
    expect(byId(cleanFacts({ lp: { applies: true, burnedOrLockedPct: null, burned: true } }), 'lp_locked').status).toBe('pass');
  });
  it('no Jupiter route on a pump.fun curve token is not a honeypot', () => {
    const f = cleanFacts({ sellSim: { routable: false, roundTripLossPct: null, sellPriceImpactPct: null } });
    expect(byId(f, 'sell_simulation').status).toBe('pass');
  });
  it('thresholds come from config', () => {
    const loose = FiltersSchema.parse({ maxBundlerPct: 35 });
    expect(byId(cleanFacts({ bundlerPct: 31.75 }), 'bundler', loose).status).toBe('pass');
  });
});

describe('runFilters', () => {
  it('unknown on a critical filter is a failure; on others only a warning', () => {
    const r = runFilters(cleanFacts({ mintRenounced: null, insiderPct: null }), cfg);
    expect(r.passed).toBe(false);
    expect(r.failures.map((x) => x.id)).toEqual(['mint_authority']);
    expect(r.failures[0]!.reason).toMatch(/required/);
    expect(r.unknowns.map((x) => x.id)).toContain('insiders');
  });
  it('cheapOnly runs only the free checks and never fails on unknowns', () => {
    const r = runFilters(cleanFacts({ mintRenounced: null, curveSol: null }), cfg, { cheapOnly: true });
    expect(r.passed).toBe(true);
    expect(r.results.some((x) => x.id === 'mint_authority')).toBe(false);
  });
  it('the GMGN screenshot token (Bundler 31.75%) is rejected on bundler alone', () => {
    const r = runFilters(
      cleanFacts({ taxPct: 1.25, top10Pct: 21.16, bundlerPct: 31.75, phishingPct: 2.03, insiderPct: 0, sniperPct: 0, devHoldPct: 0, rugRatio: 0.02 }),
      cfg,
    );
    expect(r.failures.map((x) => x.id)).toEqual(['bundler']);
  });
});
