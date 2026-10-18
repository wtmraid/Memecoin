import type { TokenFacts } from '../filters/facts.js';
import type { FilterResult } from '../filters/filters.js';
import { gmgnUrl } from '../safety/gmgn.js';
import type { Evaluation, Signal, SignalUpdate } from '../strategy/types.js';
import { usd } from '../strategy/plan.js';

/** Escape for Telegram HTML parse mode. All third-party text goes through this. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100) / 100}%`);
const mark = (r?: FilterResult) => (!r ? '' : r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '❔');
const SRC: Record<string, string> = { gmgn: '', onchain: 'ᵒⁿ', rpc: 'ʳᵖᶜ' };

function age(sec: number | null) {
  if (sec === null) return 'n/a';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/** The GMGN "Core Metrics" grid, with pass/fail marks from our filters. */
export function coreMetrics(f: TokenFacts, results: FilterResult[]): string[] {
  const r = (id: string) => results.find((x) => x.id === id);
  const src = (k: string) => SRC[f.sources[k] ?? ''] ?? '';
  const cell = (label: string, value: string, id?: string, k?: string) => `${label} <b>${value}</b>${k ? src(k) : ''} ${id ? mark(r(id)) : ''}`.trim();
  const sniper = f.sniperPct !== null ? pct(f.sniperPct) : f.sniperCount !== null ? `${f.sniperCount} wallets` : 'n/a';
  return [
    `${cell('Taxes', pct(f.taxPct), 'tax', 'taxPct')}  ·  ${cell('Top 10', pct(f.top10Pct), 'top10', 'top10Pct')}`,
    `${cell('Bundler', pct(f.bundlerPct), 'bundler', 'bundlerPct')}  ·  ${cell('Phishing', pct(f.phishingPct), 'phishing', 'phishingPct')}`,
    `${cell('Insiders', pct(f.insiderPct), 'insiders', 'insiderPct')}  ·  ${cell('Sniper', sniper, 'sniper', 'sniperPct')}`,
    `${cell('Dev holdings', pct(f.devHoldPct), 'dev_holding', 'devHoldPct')}  ·  Dev Migrated <b>${f.devMigrated ?? 'n/a'}</b>`,
    `${cell('Rug', f.rugRatio === null ? 'n/a' : pct(f.rugRatio * 100), 'dev_history')}${f.creatorStatus ? `  ·  Dev ${f.creatorStatus === 'hold' ? 'still holding' : 'sold/closed'}` : ''}`,
    `🫧 Clusters <b>${f.clusterPct === null ? 'n/a' : pct(f.clusterPct)}</b>${f.clusters[0] ? ` (${f.clusters[0].wallets} wallets, one funder)` : ''} ${mark(r('clusters'))}  ·  Dev-linked ${pct(f.devLinkedPct)}  ·  Fresh ${pct(f.freshWalletPct)} ${mark(r('fresh_wallets'))}`,
  ];
}

/** GMGN's four check marks: NoMint · NoFreeze · LP burned (or curve) · Top 10 OK. */
export function checks(results: FilterResult[]): string {
  const r = (id: string) => results.find((x) => x.id === id);
  return `${mark(r('mint_authority'))} NoMint  ${mark(r('freeze_authority'))} NoFreeze  ${mark(r('lp_locked'))} LP  ${mark(r('top10'))} Top10  ${mark(r('sell_simulation'))} Sellable`;
}

function header(e: Evaluation): string[] {
  const f = e.facts;
  const sym = esc(f.symbol ?? '???');
  const name = f.name ? ` (${esc(f.name)})` : '';
  const stage = f.onCurve
    ? `📈 Curve ${f.curveProgress === null ? 'n/a' : `${Math.round(f.curveProgress * 100)}%`}${f.curveSol !== null ? ` · ${f.curveSol.toFixed(1)} SOL` : ''}`
    : f.migrated
      ? '🎓 Migrated'
      : `🏊 ${esc(f.venue ?? 'DEX')}`;
  return [
    `<b>$${sym}</b>${name}`,
    `<code>${f.mint}</code>`,
    `⏱ ${age(f.ageSec)} · ${stage} · MC <b>${f.mcapUsd ? usd(f.mcapUsd) : 'n/a'}</b>${f.athMcapUsd ? ` · ATH ${usd(f.athMcapUsd)}` : ''} · 👥 ${f.holderCount ?? 'n/a'}`,
  ];
}

function scoreLines(e: Evaluation): string[] {
  return e.score.features
    .filter((x) => x.value !== null)
    .sort((a, b) => b.weight * b.value! - a.weight * a.value!)
    .map((x) => `• ${x.key} ${Math.round(x.value! * 100)}/100 — ${esc(x.note)}`);
}

function flagLines(e: Evaluation): string[] {
  const out = e.filters.failures.map((x) => `❌ ${x.label}: ${esc(x.reason)}`);
  out.push(...e.filters.unknowns.map((x) => `❔ ${x.label}: ${esc(x.reason)}`));
  if (e.facts.social.negativeMentions1h) out.push(`⚠️ ${e.facts.social.negativeMentions1h} posts calling it a rug/scam (1h)`);
  if (e.facts.sellSim?.roundTripLossPct !== null && e.facts.sellSim?.roundTripLossPct !== undefined)
    out.push(`ℹ️ Sell test: ${e.facts.sellSim.roundTripLossPct}% round-trip loss (fees + price impact)`);
  return out;
}

const DISCLAIMER = '<i>Rule-based signal, not financial advice. Memecoins can go to zero in seconds — only risk what you can lose.</i>';

/** Buy alert (Telegram HTML). */
export function formatSignal(s: Signal): string {
  const modeIcon = s.mode === 'SNIPE' ? '🎯 SNIPE' : '📊 SCALP';
  return [
    `${modeIcon} · <b>Score ${s.score.score}/100</b> · data ${Math.round(s.score.coverage * 100)}%`,
    ...header(s),
    '',
    '<b>Core Metrics</b>',
    ...coreMetrics(s.facts, s.filters.results),
    checks(s.filters.results),
    '',
    `<b>Why now</b> — ${esc(s.modeReasons.join(' · '))}`,
    ...scoreLines(s).slice(0, 6),
    ...(flagLines(s).length ? ['', '<b>Flags</b>', ...flagLines(s)] : []),
    '',
    '<b>Plan (rule, not advice)</b>',
    ...s.plan.lines.map((l) => `• ${esc(l)}`),
    '',
    `🔗 <a href="${gmgnUrl(s.mint)}">Open on GMGN</a>`,
    DISCLAIMER,
  ].join('\n');
}

/** Reply to /scan: same layout, plus the verdict. */
export function formatScan(e: Evaluation): string {
  return [
    `<b>${esc(e.verdict)}</b>`,
    ...header(e),
    '',
    '<b>Core Metrics</b>',
    ...coreMetrics(e.facts, e.filters.results),
    checks(e.filters.results),
    '',
    `<b>Score ${e.score.score}/100</b> (data ${Math.round(e.score.coverage * 100)}%)`,
    ...scoreLines(e).slice(0, 6),
    ...(e.mode ? [] : [`<b>Entry trigger not met:</b> ${esc(e.modeReasons.slice(0, 3).join('; '))}`]),
    ...(flagLines(e).length ? ['', '<b>Flags</b>', ...flagLines(e)] : []),
    ...(e.plan && e.filters.passed ? ['', '<b>Plan if you enter (rule, not advice)</b>', ...e.plan.lines.map((l) => `• ${esc(l)}`)] : []),
    '',
    `🔗 <a href="${gmgnUrl(e.mint)}">Open on GMGN</a>`,
  ].join('\n');
}

const UPDATE_ICON: Record<SignalUpdate['kind'], string> = {
  tp1: '💰 TAKE PROFIT',
  tp2: '💰 TAKE PROFIT',
  migration: '🎓 DE-RISK',
  trailing_stop: '🟡 SELL',
  time_stop: '⏰ SELL',
  stop_loss: '🔴 STOP-LOSS',
  emergency: '🚨 SELL NOW',
  max_hold: '⏰ SELL',
  closed: '🏁 CLOSED',
  missed_entry: '⛔ NO ENTRY',
};

/** Sell recommendation, sent as a reply to the original alert. */
export function formatUpdate(u: SignalUpdate): string {
  const head =
    u.kind === 'closed'
      ? `${UPDATE_ICON.closed} $${esc(u.symbol ?? '???')}`
      : `${UPDATE_ICON[u.kind]} ${Math.round(u.sellPct)}% of position · $${esc(u.symbol ?? '???')}`;
  return [
    `<b>${head}</b>`,
    esc(u.reason),
    `Now <b>${u.multiple.toFixed(2)}x</b>${u.mcapUsd ? ` · MC ${usd(u.mcapUsd)}` : ''} · holding ${Math.round(u.remainingPct)}% · paper P&L ${u.pnlPct >= 0 ? '+' : ''}${u.pnlPct.toFixed(1)}%`,
    `🔗 <a href="${gmgnUrl(u.mint)}">Open on GMGN</a>`,
  ].join('\n');
}

/** Strip HTML for plain-text channels (Discord). */
export const toPlain = (html: string) =>
  html
    .replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2: $1')
    .replace(/<\/?(b|i|code)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
