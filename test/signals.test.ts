import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/bus.js';
import { HttpClient, TokenBucket } from '../src/core/http.js';
import { FiltersSchema, ScoringSchema, StrategySchema } from '../src/config/strategy.js';
import { TradeBooks } from '../src/analysis/tradeBook.js';
import { MentionTracker } from '../src/ingest/social/velocity.js';
import { TokenRegistry } from '../src/pipeline/registry.js';
import { mapGmgn, type GmgnClient } from '../src/safety/gmgn.js';
import type { JupiterSellSim } from '../src/safety/jupiter.js';
import { Evaluator } from '../src/strategy/evaluator.js';
import { PositionMonitor } from '../src/strategy/positions.js';
import { formatScan, formatSignal, formatUpdate, toPlain } from '../src/alerts/format.js';
import { TelegramBot } from '../src/alerts/telegram.js';
import { AlertService, startChatIdHelper } from '../src/alerts/service.js';
import type { PumpTrade } from '../src/core/types.js';
import type { Signal, SignalUpdate } from '../src/strategy/types.js';
import { key, silent } from './helpers.js';
import info from './fixtures/gmgn-info.json' with { type: 'json' };
import sec from './fixtures/gmgn-security.json' with { type: 'json' };

const MINT = key(77);
const DEV = key(78);
const regOpts = { trackMaxAgeSec: 3600, maxTrackedTokens: 100, marketRefreshSec: 999, holdersRefreshSec: 999, curveRefreshSec: 999, holdersPerCycle: 1, curveFromTradeThrottleMs: 0 };

/** Clean GMGN payload: same shape as the screenshot but with a small bundle. */
const cleanSec = { ...sec, bundler_trader_amount_rate: '0.04' };
const cleanInfo = { ...info, stat: { ...info.stat, top_bundler_trader_percentage: 0.04 }, link: { ...info.link, twitter_username: 'realcoin', website: 'https://realcoin.fun' } };

function world(gmgnPayload: { info: object; sec: object }, over: { strategy?: object; scoring?: object } = {}) {
  let now = 1_000_000;
  const bus = new EventBus((e, err) => {
    throw err;
  });
  const registry = new TokenRegistry(bus, { marketSnapshots: async () => new Map() }, silent, regOpts, () => now);
  const books = new TradeBooks();
  bus.on('token.created', (c) => books.onCreate(c));
  bus.on('pumpfun.trade', (t) => books.onTrade(t));
  const gmgn = { facts: vi.fn(async (m: string) => mapGmgn(m, gmgnPayload.info, gmgnPayload.sec)), devHistory: vi.fn(async () => ({ launches: 6, migrated: 2, gradRate: 0.33 })) } as unknown as GmgnClient;
  const sellSim = { simulate: vi.fn(async () => ({ routable: true, roundTripLossPct: 4, sellPriceImpactPct: 1 })) } as unknown as JupiterSellSim;
  const strategy = StrategySchema.parse({ paper: { latencyMs: 0 }, ...over.strategy });
  const ev = new Evaluator(
    {
      bus, registry, books, mentions: new MentionTracker(), log: silent, gmgn, sellSim,
      mintInfo: async () => ({ mintAuthority: null, freezeAuthority: null, decimals: 6, supply: 1n, isToken2022: false, extensions: [], transferFeeBps: 0, dangerous: [] }),
      now: () => now,
    },
    { filters: FiltersSchema.parse({}), scoring: ScoringSchema.parse({ ...over.scoring }), strategy },
  );
  ev.sol.update(150);
  const pos = new PositionMonitor(bus, registry, books, ev.sol, ev.series, strategy, silent, {}, () => now);
  const signals: Signal[] = [];
  const updates: SignalUpdate[] = [];
  const shadows: Signal[] = [];
  bus.on('signal.shadow', (s) => shadows.push(s));
  bus.on('signal.buy', (s) => signals.push(s));
  bus.on('signal.update', (u) => updates.push(u));

  // Virtual reserves move with buys so price rises like a real curve.
  let vSol = 30_000_000_000n;
  let vTok = 1_073_000_000_000_000n;
  let realTok = 793_100_000_000_000n;
  let slot = 500;
  const trade = (user: string, isBuy: boolean, sol: bigint, at: number): PumpTrade => {
    const tokens = (vTok * sol) / (vSol + sol);
    if (isBuy) {
      vSol += sol;
      vTok -= tokens;
      realTok -= tokens;
    } else {
      vSol -= sol;
      vTok += tokens;
      realTok += tokens;
    }
    return { mint: MINT, user, isBuy, solAmount: sol, tokenAmount: tokens, virtualSolReserves: vSol, virtualTokenReserves: vTok, realSolReserves: vSol - 30_000_000_000n, realTokenReserves: realTok, signature: `t${slot}`, slot: slot++, ts: at };
  };
  const launch = () => {
    bus.emit('token.created', { mint: MINT, name: 'Real Coin', symbol: 'REAL', uri: '', bondingCurve: key(79), creator: DEV, venue: 'pumpfun', signature: 'c', slot: 500, ts: now });
    bus.emit('pumpfun.trade', { ...trade(DEV, true, 500_000_000n, now), slot: 500 });
    // 80 distinct organic buyers over ~4 minutes, a few sellers
    for (let i = 0; i < 80; i++) {
      now += 3000;
      bus.emit('pumpfun.trade', trade(key(100 + i), true, 300_000_000n, now));
      if (i % 6 === 5) bus.emit('pumpfun.trade', trade(key(100 + i - 3), false, 100_000_000n, now));
    }
  };
  return {
    bus, ev, pos, gmgn, sellSim, signals, updates, shadows, launch, trade, books,
    advance: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}

describe('signal pipeline end-to-end', () => {
  it('a clean, busy pump.fun launch produces one SNIPE signal with full Core Metrics', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.launch();
    await w.ev.tick();
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
    const s = w.signals[0]!;
    expect(s.mode).toBe('SNIPE');
    expect(s.filters.passed).toBe(true);
    expect(s.score.score).toBeGreaterThanOrEqual(65);
    expect(s.facts).toMatchObject({ symbol: 'REAL', bundlerPct: 4, top10Pct: 21.16, devMigrated: 48, rugRatio: 0.02, onCurve: true });
    expect(s.facts.sources.bundlerPct).toBe('gmgn');
    expect(w.sellSim.simulate).toHaveBeenCalledTimes(1);

    await w.ev.tick(); // no duplicate alert
    expect(w.signals).toHaveLength(1);
    await w.ev.evaluate(MINT, { deep: true }); // re-evaluation reuses the cached sell test
    expect(w.sellSim.simulate).toHaveBeenCalledTimes(1);
  });

  it('a launch that is too young at first is not blacklisted — it is signaled once it matures', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.launch();
    // Pretend the first look happened when it was 30 s old: fails only the age gate.
    const young = w.ev.judge({ ...w.ev.buildFacts(MINT), ageSec: 30 }, { cheapOnly: true });
    expect(young.filters.failures.map((f) => f.id)).toEqual(['age']);
    (w.ev as any).reject(MINT, ['age'], w.now);
    await w.ev.tick();
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
  });

  it('the screenshot token (Bundler 31.75%) is rejected and never reaches the sell test', async () => {
    const w = world({ info, sec });
    w.launch();
    await w.ev.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(w.signals).toHaveLength(0);
    expect(w.sellSim.simulate).not.toHaveBeenCalled();
    const scan = await w.ev.evaluate(MINT, { deep: true });
    expect(scan.verdict).toMatch(/REJECT.*bundled supply 31\.75%/);
  });

  it('follows the signal: TP1 at 2x, then a dev dump triggers SELL NOW', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.launch();
    await w.ev.tick();
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
    w.advance(2000);
    w.bus.emit('pumpfun.trade', w.trade(key(250), true, 1_000_000n, w.now)); // entry fills after latency
    // pump: big buys until ≥ 2x
    for (let i = 0; i < 60 && !w.updates.some((u) => u.kind === 'tp1'); i++) {
      w.advance(1000);
      w.bus.emit('pumpfun.trade', w.trade(key(300 + i), true, 3_000_000_000n, w.now));
    }
    const tp1 = w.updates.find((u) => u.kind === 'tp1')!;
    expect(tp1).toMatchObject({ sellPct: 50, remainingPct: 50 });
    expect(tp1.multiple).toBeGreaterThanOrEqual(2);
    // dev sells their whole bag
    w.advance(1000);
    const devBag = w.books.get(MINT)!.net(DEV);
    w.bus.emit('pumpfun.trade', { ...w.trade(DEV, false, 400_000_000n, w.now), tokenAmount: devBag });
    const em = w.updates.find((u) => u.kind === 'emergency')!;
    expect(em.reason).toMatch(/dev sold/);
    expect(em.sellPct).toBe(50);
    expect(w.updates.at(-1)!.kind).toBe('closed');
    expect(w.updates.at(-1)!.pnlPct).toBeGreaterThan(0);
  });
});

describe('alert formatting', () => {
  it('buy alert mirrors GMGN Core Metrics and links only to the exact GMGN token page', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.launch();
    await w.ev.tick();
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
    const html = formatSignal(w.signals[0]!);
    for (const label of ['Taxes', 'Top 10', 'Bundler', 'Phishing', 'Insiders', 'Sniper', 'Dev holdings', 'Dev Migrated', 'Rug']) expect(html).toContain(label);
    expect(html).toContain('Top 10 <b>21.16%</b>');
    expect(html).toContain('Dev Migrated <b>48</b>');
    expect(html).toContain(`<code>${MINT}</code>`);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual([`https://gmgn.ai/sol/token/${MINT}`]);
    expect(html).toMatch(/rule, not advice/);
    expect(html).not.toMatch(/dexscreener|solscan|rugcheck\.xyz/i);
  });

  it('escapes token names so a malicious name cannot inject HTML', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.launch();
    const e = await w.ev.evaluate(MINT, { deep: true });
    e.facts.name = '<a href="https://evil">x</a>';
    const html = formatScan(e);
    expect(html).not.toContain('<a href="https://evil"');
    expect(html).toContain('&lt;a href=');
  });

  it('sell update and plain-text conversion', () => {
    const u: SignalUpdate = { signalId: 's', mint: MINT, symbol: 'REAL', kind: 'tp1', sellPct: 50, remainingPct: 50, price: 2e-7, multiple: 2.04, mcapUsd: 81_000, reason: 'TP1 hit: 2.04x', pnlPct: 45.2, ts: 0 };
    const html = formatUpdate(u);
    expect(html).toMatch(/TAKE PROFIT 50% of position/);
    expect(toPlain(html)).toContain(`Open on GMGN: https://gmgn.ai/sol/token/${MINT}`);
  });
});

describe('Telegram delivery', () => {
  it('sends alerts with a GMGN button and threads sell updates as replies', async () => {
    const bodies: any[] = [];
    let id = 10;
    const http = new HttpClient(new TokenBucket(1000, 1000), async (_u, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: id++ } }), { status: 200 });
    });
    const bus = new EventBus();
    const bot = new TelegramBot(http, 'TOKEN', silent, 0);
    new AlertService(bus, silent, { telegram: { bot, chatId: '-100' }, minScore: 0 });
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.launch();
    await w.ev.tick();
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
    bus.emit('signal.buy', w.signals[0]!);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    bus.emit('signal.update', { signalId: w.signals[0]!.id, mint: MINT, kind: 'stop_loss', sellPct: 100, remainingPct: 0, price: 1, multiple: 0.7, mcapUsd: null, reason: 'stop', pnlPct: -33, ts: 0 });
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toMatchObject({ chat_id: '-100', parse_mode: 'HTML' });
    expect(bodies[0].reply_markup.inline_keyboard[0][0]).toEqual({ text: '📈 Open on GMGN', url: `https://gmgn.ai/sol/token/${MINT}` });
    expect(bodies[1].reply_parameters.message_id).toBe(10);
  });

  it('retries after Telegram 429 retry_after', async () => {
    let n = 0;
    const http = new HttpClient(new TokenBucket(1000, 1000), async () =>
      n++ === 0
        ? new Response(JSON.stringify({ ok: false, parameters: { retry_after: 0 } }), { status: 429 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 }),
    );
    expect(await new TelegramBot(http, 'T', silent, 0).send('1', 'hi')).toBe(5);
  });
});

describe('Telegram commands', () => {
  /** Fake Bot API: one incoming message, then empty polls; records sendMessage bodies. */
  function fakeApi(text: string, chatId = 42) {
    const sent: any[] = [];
    let delivered = false;
    const http = new HttpClient(new TokenBucket(1000, 1000), async (url, init) => {
      if (url.endsWith('/getUpdates')) {
        const result = delivered ? [] : [{ update_id: 1, message: { message_id: 7, chat: { id: chatId }, text } }];
        delivered = true;
        if (!result.length) await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), { status: 200 });
    });
    return { http, sent };
  }

  it('/status replies with the status text in the alert chat only', async () => {
    const { http, sent } = fakeApi('/status');
    const bot = new TelegramBot(http, 'T', silent, 0);
    const svc = new AlertService(new EventBus(), silent, { telegram: { bot, chatId: '42' }, status: () => 'ALL GOOD', minScore: 0 });
    svc.startCommands();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bot.stopPolling();
    expect(sent[0]).toMatchObject({ chat_id: '42', text: 'ALL GOOD', reply_parameters: { message_id: 7 } });
  });

  it('ignores commands from other chats', async () => {
    const { http, sent } = fakeApi('/status', 666);
    const bot = new TelegramBot(http, 'T', silent, 0);
    new AlertService(new EventBus(), silent, { telegram: { bot, chatId: '42' }, status: () => 'x', minScore: 0 }).startCommands();
    await new Promise((r) => setTimeout(r, 80));
    bot.stopPolling();
    expect(sent).toHaveLength(0);
  });

  it('setup mode tells you your chat id', async () => {
    const { http, sent } = fakeApi('hi', 123456);
    const bot = new TelegramBot(http, 'T', silent, 0);
    startChatIdHelper(bot);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bot.stopPolling();
    expect(sent[0].text).toContain('TELEGRAM_ALERT_CHAT_ID=123456');
  });
});

describe('entry realism, shadows and pre-warming', () => {
  it('if price runs past the "don\'t chase" limit before you could act, the paper trade is skipped', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec }, { strategy: { paper: { latencyMs: 1500 } } });
    w.launch();
    await w.ev.tick();
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
    // a +40% candle inside the reaction window
    for (let i = 0; i < 10; i++) w.bus.emit('pumpfun.trade', w.trade(key(400 + i), true, 3_000_000_000n, w.now));
    w.advance(2000);
    w.bus.emit('pumpfun.trade', w.trade(key(450), true, 1_000_000n, w.now));
    const missed = w.updates.find((u) => u.kind === 'missed_entry')!;
    expect(missed.reason).toMatch(/don't chase/);
    expect(w.updates.some((u) => u.kind === 'tp1')).toBe(false);
  });

  it('a safe near-miss (score just under the bar) is tracked silently, never alerted', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec }, { scoring: { minScoreSnipe: 99 } });
    const sent: unknown[] = [];
    w.bus.on('signal.update', (u) => !u.shadow && sent.push(u));
    w.launch();
    await w.ev.tick();
    await vi.waitFor(() => expect(w.shadows).toHaveLength(1));
    expect(w.signals).toHaveLength(0);
    expect(w.shadows[0]!.shadow).toBe(true);
    expect(w.pos.shadowCount).toBe(1);
    expect(w.pos.openSummary()).toEqual([]); // not shown in /open
    // its sell rules still run (for the tuner) but updates are flagged shadow
    for (let i = 0; i < 40; i++) {
      w.advance(1000);
      w.bus.emit('pumpfun.trade', w.trade(key(500 + i), true, 3_000_000_000n, w.now));
    }
    expect(sent).toEqual([]);
  });

  it('pre-warms deep checks for a launch that is building, before it qualifies', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.bus.emit('token.created', { mint: MINT, name: 'Real Coin', symbol: 'REAL', uri: '', bondingCurve: key(79), creator: DEV, venue: 'pumpfun', signature: 'c', slot: 500, ts: w.now });
    for (let i = 0; i < 15; i++) {
      w.advance(2000);
      w.bus.emit('pumpfun.trade', w.trade(key(600 + i), true, 300_000_000n, w.now));
    }
    await w.ev.tick(); // 15 buyers, 30s old: not yet SNIPE (needs 25) — but pre-warm starts
    await vi.waitFor(() => expect(w.gmgn.facts).toHaveBeenCalledTimes(1));
    expect(w.signals).toHaveLength(0);
    expect(w.ev.stats.prewarms).toBe(1);
  });
});

describe('socials without GMGN', () => {
  function noGmgnWorld(meta: object | null) {
    let now = 1_000_000;
    const bus = new EventBus();
    const registry = new TokenRegistry(bus, { marketSnapshots: async () => new Map() }, silent, regOpts, () => now);
    const ev = new Evaluator(
      { bus, registry, books: new TradeBooks(), mentions: new MentionTracker(), log: silent, metadataSocials: async () => meta, now: () => now },
      { filters: FiltersSchema.parse({}), scoring: ScoringSchema.parse({}), strategy: StrategySchema.parse({}) },
    );
    bus.emit('token.created', { mint: MINT, name: 'R', symbol: 'R', uri: 'https://ipfs.io/ipfs/Qm1', bondingCurve: key(79), creator: DEV, venue: 'pumpfun', signature: 'c', slot: 1, ts: now });
    // DexScreener knows the pair but there is no paid profile → no socials there
    registry.tokens.get(MINT)!.market = { mint: MINT, source: 'dexscreener', pairAddress: 'p', dexId: 'pumpfun', priceUsd: 1, priceNative: 1, liquidityUsd: 1, fdvUsd: 1, marketCapUsd: 1, volumeUsd: { m5: 0, h1: 0, h6: 0, h24: 0 }, buys: { m5: 0, h1: 0, h6: 0, h24: 0 }, sells: { m5: 0, h1: 0, h6: 0, h24: 0 }, priceChangePct: { m5: 0, h1: 0, h6: 0, h24: 0 }, pairCreatedAt: now, websites: [], socials: [], ts: now };
    return ev;
  }

  it('uses the socials from the token metadata (what pump.fun shows)', async () => {
    const e = await noGmgnWorld({ twitter: 'https://x.com/realcoin' }).evaluate(MINT, { deep: true });
    expect(e.facts.socials.twitter).toBe('https://x.com/realcoin');
    expect(e.filters.results.find((r) => r.id === 'socials')!.status).toBe('pass');
  });

  it('a missing paid DexScreener profile alone never counts as "no socials"', async () => {
    const e = await noGmgnWorld(null).evaluate(MINT, { deep: true });
    expect(e.filters.results.find((r) => r.id === 'socials')!.status).toBe('unknown');
  });

  it('metadata with no socials at all is a real "no socials" reject', async () => {
    const e = await noGmgnWorld({ name: 'R' }).evaluate(MINT, { deep: true });
    expect(e.filters.results.find((r) => r.id === 'socials')!.reason).toMatch(/no X/);
  });
});

import { compactScan, compactSignal, compactUpdate } from '../src/alerts/compact.js';
describe('compact cards', () => {
  it('alert is short, emoji-led, has buy/sell levels and only a GMGN button', async () => {
    const w = world({ info: cleanInfo, sec: cleanSec });
    w.launch();
    await w.ev.tick();
    await vi.waitFor(() => expect(w.signals).toHaveLength(1));
    const html = compactSignal(w.signals[0]!);
    if (process.env.PREVIEW) console.log('\n' + toPlain(html) + '\n');
    expect(html.split('\n').length).toBeLessThanOrEqual(16);
    expect(html).toMatch(/NEW CALL — \$REAL/);
    expect(html).toMatch(/🟢 Buy: now, up to/);
    expect(html).toMatch(/🎯 Sell 50% at 2x/);
    expect(html).toMatch(/🛑 Stop: −30%/);
    expect(html).toMatch(/🛡 Passed all safety checks/);
    expect(html).not.toMatch(/Bundler|Phishing|Insiders/); // details live in /full
    expect(html).not.toMatch(/href=/);
  });

  it('scan shows a one-word verdict and the main reason to avoid', async () => {
    const w = world({ info, sec });
    w.launch();
    const html = compactScan(await w.ev.evaluate(MINT, { deep: true }));
    if (process.env.PREVIEW) console.log('\n' + toPlain(html) + '\n');
    expect(html).toMatch(/^❌ <b>AVOID<\/b> — \$REAL/);
    expect(html).toMatch(/🚫 bundled supply 31\.75%/);
  });

  it('sell update is two or three short lines', () => {
    const html = compactUpdate({ signalId: 's', mint: MINT, symbol: 'REAL', kind: 'emergency', sellPct: 50, remainingPct: 0, price: 1, multiple: 1.42, mcapUsd: 26_000, reason: 'dev sold 100% of their bag', pnlPct: 20, ts: 0 });
    if (process.env.PREVIEW) console.log('\n' + toPlain(html) + '\n');
    expect(html).toBe('<b>🚨 SELL ALL NOW</b> · $REAL\ndev sold 100% of their bag\nNow 1.42x · MC $26.0K');
  });
});

import { formatStatus } from '../src/alerts/compact.js';
describe('status card', () => {
  const base = { uptimeMs: 8.6 * 3600_000, streamOn: true, lastEventAgoSec: 2, events: 968_744, gmgn: false, jupiter: true, rugcheck: true, solUsd: 105, watching: 2000, deepChecked: 12, rejected: 554, reasons: [['top10', 449], ['dev_holding', 105]] as [string, number][], sent: 0, open: 0, learning: 2 };
  it('is spaced out, plain English, and says when the feed last worked', () => {
    const t = formatStatus(base);
    if (process.env.PREVIEW) console.log('\n' + toPlain(t) + '\n');
    expect(t).toContain('✅ Live feed: working (last event 2s ago)');
    expect(t).toContain('• Top 10 hold too much — 449');
    expect(t).toContain('\n\n');
  });
  it('flags a dead feed with the likely cause', () => {
    expect(formatStatus({ ...base, lastEventAgoSec: 900 })).toContain('❌ Live feed: no events for 15 min — check Helius credits');
  });
});
