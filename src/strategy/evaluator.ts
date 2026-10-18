import { randomUUID } from 'node:crypto';
import type { EventBus } from '../core/bus.js';
import type { Logger } from '../core/logger.js';
import type { FilterSettings, ScoringSettings, StrategySettings } from '../config/strategy.js';
import { SeriesStore, SolPrice, TtlCache, WindowCounter } from '../analysis/context.js';
import type { TradeBooks } from '../analysis/tradeBook.js';
import { emptyFacts, type TokenFacts } from '../filters/facts.js';
import { runFilters, type FilterReport } from '../filters/filters.js';
import type { MentionTracker } from '../ingest/social/velocity.js';
import type { TokenRegistry } from '../pipeline/registry.js';
import type { GmgnClient, GmgnFacts } from '../safety/gmgn.js';
import type { JupiterSellSim, SellSimResult } from '../safety/jupiter.js';
import type { MintInfo } from '../safety/mintInfo.js';
import type { RugcheckClient, RugcheckSummary } from '../safety/rugcheck.js';
import { checkSocials, SocialIndex, type SocialLinks } from '../safety/socials.js';
import { scoreToken } from '../scoring/score.js';
import { buildPlan, decideMode } from './plan.js';
import type { Evaluation, Signal } from './types.js';
import { WSOL_MINT } from '../ingest/onchain/programs.js';
import type { ClusterReport } from '../safety/clusters.js';

export interface DeepData {
  gmgn?: GmgnFacts | null;
  mint?: MintInfo | null;
  rugcheck?: RugcheckSummary | null;
  sellSim?: SellSimResult | null;
  devHistory?: { launches: number; migrated: number; gradRate: number | null } | null;
  clusters?: ClusterReport | null;
  /** Socials from the token's own metadata JSON (what pump.fun shows). */
  metaSocials?: SocialLinks | null;
}

export interface EvaluatorDeps {
  bus: EventBus;
  registry: TokenRegistry;
  books: TradeBooks;
  mentions: MentionTracker;
  log: Logger;
  gmgn?: GmgnClient;
  mintInfo?: (mint: string) => Promise<MintInfo | null>;
  rugcheck?: RugcheckClient;
  sellSim?: JupiterSellSim;
  /** Bubblemaps-style holder clustering (funding links between top holders). */
  clusters?: (mint: string, creator: string | null) => Promise<ClusterReport | null>;
  /** Fetch socials from a token metadata URI (pump.fun stores X/Telegram/website there). */
  metadataSocials?: (uri: string) => Promise<SocialLinks | null>;
  /** Random source for shadow sampling (injectable for tests). */
  random?: () => number;
  /** Used by forced scans of tokens we aren't tracking yet. */
  marketSnapshots?: (mints: string[]) => Promise<Map<string, import('../core/types.js').MarketSnapshot>>;
  now?: () => number;
}

export interface EvaluatorSettings {
  filters: FilterSettings;
  scoring: ScoringSettings;
  strategy: StrategySettings;
}

/** Rejections that can't heal with time — never re-check these tokens. */
const PERMANENT = new Set(['mint_authority', 'freeze_authority', 'token_extensions', 'dev_history', 'tax']);
/** "Not yet" conditions — the token may still mature into a candidate. Never blacklist on these. */
const TRANSIENT = new Set(['age', 'holders', 'liquidity']);
const MIN_COVERAGE = 0.5;

/**
 * Turns everything we know about a token into an Evaluation, and runs the signal loop:
 *   cheap on-chain gates (free, every few seconds)
 *   → deep checks (GMGN, RPC mint, RugCheck, then the Jupiter sell test last)
 *   → filters + score + mode → `signal.buy`.
 */
export class Evaluator {
  readonly sol: SolPrice;
  readonly series = new SeriesStore();
  readonly socialIndex = new SocialIndex();
  readonly creatorLaunches = new WindowCounter(24 * 3600_000);
  readonly smartBuys = new WindowCounter(3600_000);
  private names = new Map<string, { symbol?: string; name?: string; creator?: string; uri?: string }>();
  /** Why tokens get rejected (filter id → count), for /status. */
  readonly rejectReasons = new Map<string, number>();
  private deepCache: TtlCache<DeepData>;
  private devCache = new TtlCache<DeepData['devHistory']>(3600_000);
  private simCache: TtlCache<SellSimResult | null>;
  private clusterCache = new TtlCache<ClusterReport | null>(120_000);
  private prewarmed = new Map<string, number>();
  private shadowed = new Set<string>();
  private signaled = new Map<string, number>();
  private rejectedUntil = new Map<string, number>();
  private permanent = new Set<string>();
  private inflight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;
  stats = { ticks: 0, candidates: 0, deepChecks: 0, prewarms: 0, rejected: 0, signals: 0, shadows: 0 };

  constructor(
    private d: EvaluatorDeps,
    private s: EvaluatorSettings,
  ) {
    this.now = d.now ?? Date.now;
    this.sol = new SolPrice(d.bus);
    this.deepCache = new TtlCache(s.strategy.deepCheckTtlSec * 1000);
    this.simCache = new TtlCache(s.strategy.deepCheckTtlSec * 1000);
    d.bus.on('token.created', (t) => {
      this.names.set(t.mint, { symbol: t.symbol, name: t.name, creator: t.creator, uri: t.uri });
      this.creatorLaunches.add(t.creator, t.ts);
    });
    d.bus.on('wallet.trade', (w) => w.side === 'buy' && this.smartBuys.add(w.mint, w.ts));
    d.bus.on('market.snapshot', (m) => {
      if (m.liquidityUsd !== null) this.series.push(`liq:${m.mint}`, m.liquidityUsd, m.ts);
      if (m.symbol && !this.names.get(m.mint)?.symbol) this.names.set(m.mint, { ...this.names.get(m.mint), symbol: m.symbol, name: m.name });
    });
    d.bus.on('holders.snapshot', (h) => h.holderCount !== null && this.series.push(`holders:${h.mint}`, h.holderCount, h.ts));
  }

  // ---------------------------------------------------------------- facts

  /** Merge all sources into one fact sheet. Pure apart from reading in-memory state. */
  buildFacts(mint: string, deep: DeepData = {}): TokenFacts {
    const now = this.now();
    const f = emptyFacts(mint, now);
    const t = this.d.registry.tokens.get(mint);
    const book = this.d.books.get(mint);
    const mkt = t?.market;
    const g = deep.gmgn ?? null;
    const solUsd = this.sol.usd;
    const nm = this.names.get(mint);
    f.symbol = nm?.symbol ?? g?.symbol ?? mkt?.symbol;
    f.name = nm?.name ?? g?.name ?? mkt?.name;
    f.venue = t?.venue ?? mkt?.dexId;
    f.creator = nm?.creator ?? g?.creator ?? null;

    // Lifecycle
    f.migrated = !!t?.migrated || g?.launchpadStatus === 'migrated';
    f.onCurve = !f.migrated && (!!t?.onCurve || g?.launchpadStatus === 'curve') && !t?.complete;
    const createdMs = book?.createdTs ?? t?.createdMs ?? mkt?.pairCreatedAt ?? null;
    f.ageSec = createdMs ? (now - createdMs) / 1000 : null;
    f.curveProgress = book?.progress() ?? t?.curve?.progress ?? g?.launchpadProgress ?? null;
    const curveLamports = book && book.realSolReserves > 0n ? book.realSolReserves : t?.curve?.realSolReserves;
    f.curveSol = curveLamports !== undefined ? Number(curveLamports) / 1e9 : null;

    // Price / size
    const nativeIsSol = mkt?.quoteMint === WSOL_MINT || mkt?.quoteMint === undefined;
    f.priceSol = book?.lastPriceSol || (nativeIsSol ? mkt?.priceNative ?? null : null) || null;
    f.priceUsd = mkt?.priceUsd ?? g?.priceUsd ?? (f.priceSol && solUsd ? f.priceSol * solUsd : null);
    f.mcapUsd = f.onCurve && f.priceSol && solUsd ? f.priceSol * 1e9 * solUsd : mkt?.marketCapUsd ?? mkt?.fdvUsd ?? (f.priceSol && solUsd ? f.priceSol * 1e9 * solUsd : null);
    f.athMcapUsd = g?.athPriceUsd ? g.athPriceUsd * 1e9 : book?.athPriceSol && solUsd ? book.athPriceSol * 1e9 * solUsd : null;
    f.liquidityUsd = f.onCurve && f.curveSol !== null && solUsd ? f.curveSol * solUsd : mkt?.liquidityUsd ?? g?.liquidityUsd ?? null;

    // On-chain metrics (only trustworthy if we saw the launch)
    const set = <K extends keyof TokenFacts>(k: K, v: TokenFacts[K] | null | undefined, src: 'gmgn' | 'onchain' | 'rpc') => {
      if (v === null || v === undefined) return;
      (f as any)[k] = v;
      f.sources[k as string] = src;
    };
    if (book?.complete) {
      f.coverage.onchainBook = true;
      set('bundlerPct', book.pctHeld(book.bundleWallets()), 'onchain');
      set('sniperPct', book.pctHeld(book.sniperWallets(this.s.filters.sniperWindowSlots)), 'onchain');
      set('devHoldPct', book.devHoldPct(), 'onchain');
      if (f.onCurve) {
        set('top10Pct', book.topHoldersPct(10), 'onchain');
        set('holderCount', book.holderCount(), 'onchain');
      }
      f.devSoldPct = book.devSoldPct();
      if (book.uniqueTraders() >= 10) f.txPerTrader = book.txPerTrader();
    }
    if (book) {
      const w2 = book.window(120_000, now);
      const w5 = book.window(300_000, now);
      const w60 = book.window(3600_000, now);
      f.momentum.buys2m = w2.buys;
      f.momentum.sells2m = w2.sells;
      f.momentum.buys5m = w5.buys;
      f.momentum.sells5m = w5.sells;
      f.momentum.uniqueBuyers5m = w5.uniqueBuyers;
      f.momentum.uniqueBuyersTotal = [...book.wallets.values()].filter((w) => w.buys > 0).length;
      if (solUsd) {
        f.momentum.volume5mUsd = (w5.buySol + w5.sellSol) * solUsd;
        f.momentum.volumeAvg5mUsd = ((w60.buySol + w60.sellSol) * solUsd) / 12;
      }
      const p5 = book.priceAt(now - 300_000);
      if (p5 && book.lastPriceSol) f.momentum.priceChange5mPct = (book.lastPriceSol / p5 - 1) * 100;
      if (f.curveSol !== null) {
        const before = f.curveSol - (w5.buySol - w5.sellSol);
        if (before > 0.5) f.momentum.liquidityGrowth5mPct = (f.curveSol / before - 1) * 100;
      }
    }
    if (mkt && (!book || !f.onCurve)) {
      f.coverage.market = true;
      f.momentum.buys5m = mkt.buys.m5;
      f.momentum.sells5m = mkt.sells.m5;
      f.momentum.volume5mUsd = mkt.volumeUsd.m5;
      f.momentum.volumeAvg5mUsd = mkt.volumeUsd.h1 / 12;
      f.momentum.priceChange5mPct = mkt.priceChangePct.m5;
      f.momentum.uniqueBuyers5m = mkt.uniqueBuyers?.m5 ?? f.momentum.uniqueBuyers5m;
      if (mkt.liquidityUsd) {
        f.volToLiq1h = mkt.volumeUsd.h1 / mkt.liquidityUsd;
        const liq5 = this.series.at(`liq:${mint}`, now - 300_000);
        if (liq5) f.momentum.liquidityGrowth5mPct = (mkt.liquidityUsd / liq5 - 1) * 100;
      }
    }

    // GMGN Core Metrics override on-chain estimates (they see transfers, clusters, history)
    if (g) {
      f.coverage.gmgn = true;
      set('taxPct', g.taxPct, 'gmgn');
      set('top10Pct', g.top10Pct, 'gmgn');
      set('bundlerPct', g.bundlerPct, 'gmgn');
      set('phishingPct', g.phishingPct, 'gmgn');
      set('insiderPct', g.insiderPct, 'gmgn');
      set('sniperCount', g.sniperCount, 'gmgn');
      set('devHoldPct', g.devHoldPct, 'gmgn');
      set('devTeamHoldPct', g.devTeamHoldPct, 'gmgn');
      set('devMigrated', g.devMigrated, 'gmgn');
      set('rugRatio', g.rugRatio, 'gmgn');
      set('holderCount', g.holderCount, 'gmgn');
      f.creatorStatus = g.creatorStatus;
      f.isWashTrading = g.isWashTrading;
      f.mintRenounced = g.mintRenounced;
      f.freezeRenounced = g.freezeRenounced;
      f.smartMoney.gmgnSmart = g.smartWallets;
      f.smartMoney.gmgnRenowned = g.renownedWallets;
      f.lp.burned = g.lpBurned;
    }
    const holders = f.holderCount ?? this.series.latest(`holders:${mint}`);
    if (holders !== null && f.ageSec) f.momentum.holdersPerMin = holders / Math.max(1, f.ageSec / 60);
    if (f.holderCount === null && holders !== null) f.holderCount = holders;

    // RPC mint account is authoritative for authorities / extensions
    if (deep.mint) {
      f.coverage.rpc = true;
      f.mintRenounced = deep.mint.mintAuthority === null;
      f.freezeRenounced = deep.mint.freezeAuthority === null;
      f.dangerousExtensions = deep.mint.dangerous;
      if (deep.mint.transferFeeBps) set('taxPct', Math.max(f.taxPct ?? 0, deep.mint.transferFeeBps / 100), 'rpc');
    }
    if (deep.devHistory) {
      f.devLaunches = deep.devHistory.launches;
      f.devGradRate = deep.devHistory.gradRate;
      if (f.devMigrated === null) f.devMigrated = deep.devHistory.migrated;
    }
    if (f.creator) f.creatorLaunches24h = this.creatorLaunches.count(f.creator, now);
    if (deep.clusters) {
      f.coverage.clusters = true;
      f.clusterPct = deep.clusters.largestClusterPct;
      f.devLinkedPct = deep.clusters.devLinkedPct;
      f.clusters = deep.clusters.clusters.slice(0, 3).map((c) => ({ pct: c.pct, wallets: c.owners.length, includesDev: c.includesDev }));
      f.sources.clusterPct = 'onchain';
    }
    if (g?.freshWalletPct !== null && g?.freshWalletPct !== undefined) set('freshWalletPct', g.freshWalletPct, 'gmgn');
    else if (deep.clusters && deep.clusters.analyzed >= 5) set('freshWalletPct', deep.clusters.freshHolderPct, 'onchain');

    f.lp.applies = !f.onCurve;
    if (deep.rugcheck) {
      f.coverage.rugcheck = true;
      f.rugcheck = deep.rugcheck;
      f.lp.burnedOrLockedPct = deep.rugcheck.lpLockedPct;
    }
    if (deep.sellSim) {
      f.coverage.sellSim = true;
      f.sellSim = deep.sellSim;
    }

    // Socials: GMGN first, then the token's own metadata (what pump.fun shows), then a
    // paid DexScreener profile. "No socials" is only judged from GMGN or metadata — most
    // launches have no paid DexScreener profile, so its absence there proves nothing.
    const meta = deep.metaSocials ?? {};
    const socials: SocialLinks = { ...meta, ...Object.fromEntries(Object.entries(g?.socials ?? {}).filter(([, v]) => v)) };
    for (const s of mkt?.socials ?? []) {
      if ((s.type === 'twitter' || s.type === 'x') && !socials.twitter) socials.twitter = s.url;
      if (s.type === 'telegram' && !socials.telegram) socials.telegram = s.url;
    }
    if (!socials.website && mkt?.websites[0]) socials.website = mkt.websites[0];
    f.socials = socials;
    if (g || deep.metaSocials) f.socialCheck = checkSocials(socials);

    // Mentions (mint and $TICKER), incl. KOL / caller channels like volume-signal groups
    const keys = [`mint:${mint}`, ...(f.symbol ? [`ticker:${f.symbol.toUpperCase()}`] : [])];
    for (const k of keys) {
      const h = this.d.mentions.velocity(k, 3600, now);
      const m5 = this.d.mentions.velocity(k, 300, now);
      f.social.mentions1h += h.count;
      f.social.mentions5m += m5.count;
      f.social.kolMentions1h += h.kolMentions;
      f.social.uniqueAuthors1h += h.uniqueAuthors;
      f.social.negativeMentions1h += h.negativeMentions;
      f.social.acceleration = Math.max(f.social.acceleration, Number.isFinite(m5.acceleration) ? m5.acceleration : 3);
    }
    f.smartMoney.watchedWalletBuys = this.smartBuys.count(mint, now);
    return f;
  }

  // ---------------------------------------------------------------- deep checks

  private async loadDeep(mint: string, withSellSim: boolean, base: DeepData = {}): Promise<DeepData> {
    const out: DeepData = { ...base };
    const jobs: Promise<unknown>[] = [];
    if (this.d.gmgn && out.gmgn === undefined)
      jobs.push(this.d.gmgn.facts(mint).then((v) => (out.gmgn = v), (e) => this.warn('gmgn', mint, e)));
    if (this.d.mintInfo && out.mint === undefined)
      jobs.push(this.d.mintInfo(mint).then((v) => (out.mint = v), (e) => this.warn('mint', mint, e)));
    if (this.d.rugcheck && out.rugcheck === undefined)
      jobs.push(this.d.rugcheck.summary(mint).then((v) => (out.rugcheck = v), (e) => this.warn('rugcheck', mint, e)));
    await Promise.all(jobs);

    const creator = this.names.get(mint)?.creator ?? out.gmgn?.creator;
    if (this.d.gmgn && creator && out.devHistory === undefined) {
      out.devHistory = await this.devCache
        .get(creator, () => this.d.gmgn!.devHistory(creator))
        .catch((e) => (this.warn('devHistory', mint, e), null));
    }
    const uri = this.names.get(mint)?.uri;
    if (this.d.metadataSocials && uri && out.metaSocials === undefined) {
      out.metaSocials = await this.d.metadataSocials(uri).catch((e) => this.warn('metadata', mint, e));
    }
    if (this.d.clusters && out.clusters === undefined) {
      const cl = this.d.clusters;
      out.clusters = await this.clusterCache.get(mint, () => cl(mint, creator ?? null).catch((e) => (this.warn('clusters', mint, e), null)));
    }
    if (withSellSim && this.d.sellSim && !out.sellSim) {
      const sim = this.d.sellSim;
      out.sellSim = await this.simCache.get(mint, () =>
        sim.simulate(mint, this.s.filters.sellSimSizeSol).catch((e) => (this.warn('sellSim', mint, e), null)),
      );
    }
    return out;
  }

  private warn(what: string, mint: string, e: unknown) {
    this.d.log.debug({ what, mint, err: String(e) }, 'deep check source failed');
    return null;
  }

  /**
   * Full evaluation of one token. Used by the signal loop and by /scan.
   * The sell simulation only runs once everything else passes (Jupiter free = 1 rps).
   */
  async evaluate(mint: string, opts: { deep: boolean; force?: boolean } = { deep: true }): Promise<Evaluation> {
    let deep: DeepData = {};
    if (opts.force) await this.prepare(mint);
    if (opts.deep) {
      this.stats.deepChecks++;
      deep = opts.force ? await this.loadDeep(mint, false) : await this.deepCache.get(mint, () => this.loadDeep(mint, false));
      const pre = runFilters(this.withSellSimPlaceholder(this.buildFacts(mint, deep)), this.s.filters);
      if (pre.passed || opts.force) deep = { ...deep, ...(await this.loadDeep(mint, true, deep)) };
    }
    const facts = this.buildFacts(mint, deep);
    return this.judge(facts, { cheapOnly: !opts.deep });
  }

  /** Start tracking a token on demand and pull its market data now (for /scan). */
  async prepare(mint: string) {
    const t = this.d.registry.track(mint, {});
    if (!this.d.marketSnapshots) return;
    try {
      const m = (await this.d.marketSnapshots([mint])).get(mint);
      if (m) {
        t.market = m;
        t.lastMarketAt = this.now();
        this.d.bus.emit('market.snapshot', m);
      }
    } catch (err) {
      this.warn('market', mint, err);
    }
  }

  /** Lets the pre-sell-sim filter pass ignore the (not yet run) sell test. */
  private withSellSimPlaceholder(f: TokenFacts): TokenFacts {
    return f.sellSim ? f : { ...f, sellSim: { routable: true, roundTripLossPct: null, sellPriceImpactPct: null } };
  }

  judge(facts: TokenFacts, opts: { cheapOnly?: boolean } = {}): Evaluation {
    const filters: FilterReport = runFilters(facts, this.s.filters, opts);
    const score = scoreToken(facts, this.s.scoring);
    const md = decideMode(facts, this.s.strategy);
    const minScore = md.mode === 'SCALP' ? this.s.scoring.minScoreScalp : this.s.scoring.minScoreSnipe;
    const actionable = !!md.mode && filters.passed && score.score >= minScore && score.coverage >= MIN_COVERAGE && !!facts.priceSol;
    const plan = facts.priceSol ? buildPlan(facts.priceSol, facts.mcapUsd, this.s.strategy) : null;
    let verdict: string;
    if (!filters.passed) verdict = `❌ REJECT — ${filters.failures.map((x) => x.reason).slice(0, 3).join('; ')}`;
    else if (!md.mode) verdict = `⏳ SAFE SO FAR, NO ENTRY YET — ${md.reasons.slice(0, 2).join('; ')}`;
    else if (score.score < minScore) verdict = `⚠️ PASSES SAFETY, WEAK MOMENTUM — score ${score.score} < ${minScore}`;
    else if (score.coverage < MIN_COVERAGE) verdict = `⚠️ NOT ENOUGH DATA — only ${Math.round(score.coverage * 100)}% of score inputs available`;
    else verdict = `✅ ${md.mode} ENTRY — score ${score.score}`;
    return { mint: facts.mint, facts, filters, score, mode: md.mode, modeReasons: md.reasons, plan, actionable, verdict };
  }

  // ---------------------------------------------------------------- loop

  async tick() {
    this.stats.ticks++;
    const now = this.now();
    const cands: string[] = [];
    const prewarm: string[] = [];
    for (const t of this.d.registry.prioritized()) {
      if (now - t.lastActivity > 10 * 60_000) break; // prioritized = most recent first
      const m = t.mint;
      if (this.permanent.has(m) || this.inflight.has(m)) continue;
      if ((this.rejectedUntil.get(m) ?? 0) > now) continue;
      const last = this.signaled.get(m);
      if (last !== undefined && now - last < this.s.strategy.scalp.cooldownSec * 1000) continue;

      const cheap = this.judge(this.buildFacts(m), { cheapOnly: true });
      if (!cheap.mode) {
        if (this.shouldPrewarm(cheap, now)) prewarm.push(m);
        continue;
      }
      if (!cheap.filters.passed) {
        this.reject(m, cheap.filters.failures.map((x) => x.id), now);
        continue;
      }
      // Save API budget: only deep-check tokens that could plausibly clear the bar.
      if (cheap.score.score < this.s.scoring.minScoreSnipe - 15) continue;
      cands.push(m);
    }
    this.stats.candidates += cands.length;
    const slots = Math.max(0, this.s.strategy.deepCheckConcurrency - this.inflight.size);
    for (const m of cands.slice(0, slots)) void this.deepAndSignal(m);
    // Spare capacity: start deep checks on launches that are building up, so when one
    // qualifies its safety data is already cached and the alert goes out immediately.
    const spare = Math.max(0, this.s.strategy.deepCheckConcurrency + this.s.strategy.prewarmConcurrency - this.inflight.size - Math.min(cands.length, slots));
    for (const m of prewarm.slice(0, spare)) void this.prewarm(m);
  }

  /** Most common rejection reasons, e.g. "dev_holding 41 · bundler 17 · socials 9". */
  topRejectReasons(n = 5): string {
    return [...this.rejectReasons].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(' · ');
  }

  private shouldPrewarm(e: Evaluation, now: number): boolean {
    const f = e.facts;
    const s = this.s.strategy;
    // "Not mature yet" failures (age, holders, curve size) are exactly what pre-warming waits out.
    if (e.filters.failures.some((x) => !TRANSIENT.has(x.id))) return false;
    if (f.ageSec === null || f.ageSec > s.snipe.maxAgeSec || f.ageSec < s.prewarmMinAgeSec) return false;
    if ((f.momentum.uniqueBuyersTotal ?? 0) < s.prewarmMinBuyers) return false;
    const last = this.prewarmed.get(e.mint);
    return last === undefined || now - last > s.deepCheckTtlSec * 1000;
  }

  private async prewarm(mint: string) {
    this.inflight.add(mint);
    this.prewarmed.set(mint, this.now());
    this.stats.prewarms++;
    try {
      const deep = await this.deepCache.get(mint, () => this.loadDeep(mint, false));
      const pre = runFilters(this.withSellSimPlaceholder(this.buildFacts(mint, deep)), this.s.filters);
      if (pre.passed) await this.loadDeep(mint, true, deep); // warms the sell-test cache too
    } catch (err) {
      this.warn('prewarm', mint, err);
    } finally {
      this.inflight.delete(mint);
    }
  }

  private reject(mint: string, ids: string[], now: number) {
    if (ids.every((id) => TRANSIENT.has(id))) return; // just not mature yet; look again next tick
    this.stats.rejected++;
    for (const id of ids) if (!TRANSIENT.has(id)) this.rejectReasons.set(id, (this.rejectReasons.get(id) ?? 0) + 1);
    if (ids.some((id) => PERMANENT.has(id))) this.permanent.add(mint);
    else this.rejectedUntil.set(mint, now + this.s.strategy.recheckRejectedAfterSec * 1000);
  }

  private async deepAndSignal(mint: string) {
    this.inflight.add(mint);
    try {
      const ev = await this.evaluate(mint, { deep: true });
      if (!ev.filters.passed) {
        const ids = ev.filters.failures.map((x) => x.id);
        this.reject(mint, ids, this.now());
        this.d.log.info({ mint, sym: ev.facts.symbol, why: ev.filters.failures.map((x) => x.reason) }, 'rejected');
        // Follow a sample of rejects silently: tells the tuner which filters actually save money.
        if (!ids.every((id) => TRANSIENT.has(id)) && (this.d.random ?? Math.random)() < this.s.strategy.shadowRejectSampleRate) this.shadow(ev, ids);
        return;
      }
      if (!ev.actionable) {
        const minScore = ev.mode === 'SCALP' ? this.s.scoring.minScoreScalp : this.s.scoring.minScoreSnipe;
        // Near-miss: safe, qualified, but scored a bit low. Track it silently so the tuner
        // can tell whether the score bar is set too high or too low.
        if (ev.mode && ev.score.score >= minScore - this.s.strategy.shadowScoreBelow) this.shadow(ev, []);
        return;
      }
      if (!ev.mode || !ev.plan) return;
      const signal: Signal = { ...ev, mode: ev.mode, plan: ev.plan, id: randomUUID(), ts: this.now() };
      this.signaled.set(mint, signal.ts);
      this.stats.signals++;
      this.d.bus.emit('signal.buy', signal);
    } catch (err) {
      this.d.log.warn({ mint, err: String(err) }, 'evaluation failed');
    } finally {
      this.inflight.delete(mint);
    }
  }

  private shadow(ev: Evaluation, rejectIds: string[]) {
    if (!ev.mode || !ev.plan || this.shadowed.has(ev.mint)) return;
    this.shadowed.add(ev.mint);
    this.stats.shadows++;
    this.d.bus.emit('signal.shadow', { ...ev, mode: ev.mode, plan: ev.plan, id: randomUUID(), ts: this.now(), shadow: true, rejectIds });
  }

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => this.d.log.warn({ err: String(e) }, 'tick failed')), this.s.strategy.evalIntervalSec * 1000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
