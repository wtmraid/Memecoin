import type { Evaluation, Signal, SignalUpdate } from '../strategy/types.js';
import { usd } from '../strategy/plan.js';
import { esc } from './format.js';

/**
 * Short, emoji-led Telegram cards: is it a good coin, where to buy, where to sell.
 * The full metric breakdown is still one command away (/full <CA>).
 */

function age(sec: number | null): string {
  if (sec === null) return '?';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const mc = (n: number | null | undefined) => (n ? usd(n) : '?');

function statLines(e: Evaluation): string[] {
  const f = e.facts;
  const liq = f.onCurve && f.curveSol !== null ? `${f.curveSol.toFixed(1)} SOL` : mc(f.liquidityUsd);
  const lines = [`💰 MC <b>${mc(f.mcapUsd)}</b> · 💧 Liq ${liq}`, `👥 ${f.holderCount ?? '?'} holders · ⏱ ${age(f.ageSec)} old`];
  const stage = f.onCurve && f.curveProgress !== null ? `📈 Bonding ${Math.round(f.curveProgress * 100)}%` : f.migrated ? '🎓 Migrated' : null;
  const buyers = f.momentum.uniqueBuyers5m ? `🔥 ${f.momentum.uniqueBuyers5m} buyers (5m)` : null;
  if (stage || buyers) lines.push([stage, buyers].filter(Boolean).join(' · '));
  return lines;
}

/** One line on safety: either "passed" or the first reasons it failed. */
function safetyLine(e: Evaluation): string {
  if (e.filters.passed) return '🛡 Passed all safety checks';
  const why = e.filters.failures.map((x) => esc(x.reason));
  return `🚫 ${why[0]}${why.length > 1 ? ` (+${why.length - 1} more)` : ''}`;
}

function planLines(e: Evaluation): string[] {
  const p = e.plan;
  if (!p) return [];
  const at = (price: number, mult: number) => (p.mcap ? usd(p.mcap.entry * mult) : `${(price / p.entryPrice).toFixed(1)}x`);
  const ex = (k: 'tp1' | 'tp2' | 'stop') => (p.mcap ? p.mcap[k] : null);
  return [
    `🟢 Buy: now, up to ${p.mcap ? usd(p.mcap.maxEntry) : '+15%'} MC`,
    `🎯 Sell 50% at 2x (${ex('tp1') ? usd(ex('tp1')!) : at(p.tp1Price, 2)})`,
    `🎯 Sell 25% at 3x (${ex('tp2') ? usd(ex('tp2')!) : at(p.tp2Price, 3)})`,
    `🛑 Stop: −30% (${ex('stop') ? usd(ex('stop')!) : at(p.stopPrice, 0.7)})`,
  ];
}

export function compactSignal(s: Signal): string {
  const sym = esc(s.facts.symbol ?? '???');
  const mode = s.mode === 'SNIPE' ? '🎯 Early snipe' : '📊 Momentum breakout';
  return [
    `🚨 <b>NEW CALL — $${sym}</b>`,
    `${mode} · ⭐ <b>${s.score.score}/100</b>`,
    '',
    ...statLines(s),
    safetyLine(s),
    '',
    ...planLines(s),
    '',
    `<code>${s.mint}</code>`,
    `<i>Rule, not advice · sell alerts come as replies</i>`,
  ].join('\n');
}

const VERDICT: [RegExp, string][] = [
  [/^❌/, '❌ <b>AVOID</b>'],
  [/^⏳/, '⏳ <b>SAFE — NOT YET</b>'],
  [/^⚠️ PASSES SAFETY/, '⚠️ <b>SAFE BUT WEAK</b>'],
  [/^⚠️/, '⚠️ <b>NOT ENOUGH DATA</b>'],
  [/^✅/, '✅ <b>GOOD ENTRY</b>'],
];

export function compactScan(e: Evaluation): string {
  const sym = esc(e.facts.symbol ?? '???');
  const v = VERDICT.find(([re]) => re.test(e.verdict))?.[1] ?? esc(e.verdict);
  const why = !e.filters.passed ? [] : !e.mode ? [`🕒 ${esc(e.modeReasons[0] ?? 'waiting for momentum')}`] : [];
  return [
    `${v} — $${sym}`,
    `⭐ ${e.score.score}/100${e.mode ? ` · ${e.mode === 'SNIPE' ? '🎯 Snipe' : '📊 Breakout'}` : ''}`,
    '',
    ...statLines(e),
    safetyLine(e),
    ...why,
    ...(e.actionable ? ['', ...planLines(e)] : []),
    '',
    `<code>${e.mint}</code>`,
    `<i>/full ${e.mint.slice(0, 4)}… for every metric</i>`,
  ].join('\n');
}

const HEAD: Record<SignalUpdate['kind'], (u: SignalUpdate) => string> = {
  tp1: (u) => `💰 SELL ${Math.round(u.sellPct)}% NOW — ${u.multiple.toFixed(1)}x hit`,
  tp2: (u) => `💰 SELL ${Math.round(u.sellPct)}% NOW — ${u.multiple.toFixed(1)}x hit`,
  migration: (u) => `🎓 SELL ${Math.round(u.sellPct)}% — migrated, lock in profit`,
  trailing_stop: () => '🟡 SELL THE REST — dropping from the top',
  time_stop: () => '⏰ SELL — not moving, free up your SOL',
  stop_loss: () => '🛑 STOP HIT — SELL ALL',
  emergency: () => '🚨 SELL ALL NOW',
  max_hold: () => '⏰ SELL — 24h max hold',
  closed: () => '🏁 Trade finished',
  missed_entry: () => "⛔ Ran too fast — don't chase",
};

export function compactUpdate(u: SignalUpdate): string {
  const sym = esc(u.symbol ?? '???');
  const result = u.kind === 'closed' ? `Result: <b>${u.pnlPct >= 0 ? '+' : ''}${u.pnlPct.toFixed(0)}%</b> (after fees)` : `Now ${u.multiple.toFixed(2)}x${u.mcapUsd ? ` · MC ${usd(u.mcapUsd)}` : ''}`;
  return [`<b>${HEAD[u.kind](u)}</b> · $${sym}`, esc(u.reason), result].join('\n');
}

/** Plain-English names for filter ids in /status. */
const REASON: Record<string, string> = {
  top10: 'Top 10 hold too much',
  dev_holding: 'Dev holds too much',
  bundler: 'Bundled launch',
  sniper: 'Too many snipers',
  wash_trading: 'Fake / bot volume',
  holders: 'Too few holders',
  liquidity: 'Too little liquidity',
  mint_authority: 'Dev can mint more',
  freeze_authority: 'Dev can freeze tokens',
  token_extensions: 'Dangerous token settings',
  tax: 'High tax',
  lp_locked: 'Liquidity not locked',
  insiders: 'Insiders',
  phishing: 'Phishing wallets',
  dev_team: 'Dev team holds too much',
  dev_history: 'Dev has rugged before',
  clusters: 'One wallet owns many holders',
  fresh_wallets: 'Too many fresh wallets',
  socials: 'No / fake socials',
  rugcheck: 'RugCheck danger',
  sell_simulation: "Can't sell (honeypot)",
};

export interface StatusData {
  uptimeMs: number;
  streamOn: boolean;
  lastEventAgoSec: number | null;
  events: number;
  gmgn: boolean;
  jupiter: boolean;
  rugcheck: boolean;
  solUsd: number | null;
  watching: number;
  deepChecked: number;
  rejected: number;
  reasons: [string, number][];
  sent: number;
  open: number;
  learning: number;
}

export function formatStatus(d: StatusData): string {
  const mins = Math.round(d.uptimeMs / 60_000);
  const up = mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
  const ago = d.lastEventAgoSec;
  const feed = !d.streamOn
    ? '⚪ Live feed: off'
    : ago === null
      ? d.uptimeMs > 120_000
        ? '❌ Live feed: can\'t connect — Helius credits used up or wrong key'
        : '🟡 Live feed: connecting…'
      : ago < 60
        ? `✅ Live feed: working (last event ${Math.round(ago)}s ago)`
        : `❌ Live feed: no events for ${Math.round(ago / 60)} min — check Helius credits`;
  const ok = (b: boolean) => (b ? '✅' : '❌');
  return [
    `<b>📊 Bot status</b> · up ${up}`,
    '',
    feed,
    `🔑 GMGN ${ok(d.gmgn)} · Jupiter ${ok(d.jupiter)} · RugCheck ${ok(d.rugcheck)}`,
    `💲 SOL ${d.solUsd ? `$${d.solUsd.toFixed(0)}` : '…'}`,
    '',
    `👀 Watching <b>${d.watching}</b> coins`,
    `🔬 Deep-checked ${d.deepChecked} · 🚫 Rejected ${d.rejected}`,
    ...(d.reasons.length
      ? ['', '<b>Why coins got rejected:</b>', ...d.reasons.map(([id, n]) => `• ${esc(REASON[id] ?? id)} — ${n}`)]
      : []),
    '',
    `🚨 Calls sent <b>${d.sent}</b> · 📂 Open ${d.open}`,
    `🧠 Learning from ${d.learning} near-misses`,
  ].join('\n');
}

export function compactRadar(r: import('../strategy/types.js').RadarPing): string {
  const sym = esc(r.facts.symbol ?? '???');
  const why = r.stage === 'building' ? '🕒 Still early — waiting for more buyers' : '⚠️ Momentum not strong enough for a call yet';
  return [
    `👀 <b>RADAR — $${sym}</b>`,
    `Safe so far · not a buy yet · ⭐ ${r.score.score}/100`,
    '',
    ...statLines(r),
    '🛡 Passed all safety checks',
    why,
    '',
    `<code>${r.mint}</code>`,
    `<i>You'll get 🚨 NEW CALL if it qualifies · /radar off to mute</i>`,
  ].join('\n');
}
