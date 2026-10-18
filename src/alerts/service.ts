import type { EventBus } from '../core/bus.js';
import type { HttpClient } from '../core/http.js';
import type { Logger } from '../core/logger.js';
import { extractMints } from '../ingest/social/extract.js';
import type { Evaluator } from '../strategy/evaluator.js';
import type { PositionMonitor } from '../strategy/positions.js';
import { formatScan, formatSignal, formatUpdate, toPlain } from './format.js';
import type { TelegramBot } from './telegram.js';

/**
 * Routes signals and sell updates to Telegram (threaded: every sell recommendation is a
 * reply to its buy alert) and optionally Discord. Handles /scan, /open and /help from
 * the alert chat.
 */
export class AlertService {
  private threads = new Map<string, number>(); // signalId → telegram message_id
  sent = 0;

  constructor(
    private bus: EventBus,
    private log: Logger,
    private opts: {
      telegram?: { bot: TelegramBot; chatId: string };
      discord?: { http: HttpClient; webhookUrl: string };
      evaluator?: Evaluator;
      positions?: PositionMonitor;
      /** Text for /status. */
      status?: () => string;
      minScore: number;
    },
  ) {
    bus.on('signal.buy', (s) => {
      if (s.score.score < opts.minScore) return;
      const html = formatSignal(s);
      void this.post(html, s.mint).then((id) => id && this.threads.set(s.id, id));
    });
    bus.on('signal.update', (u) => {
      if (u.shadow) return; // learning-only tracking, never sent
      void this.post(formatUpdate(u), u.mint, this.threads.get(u.signalId));
    });
  }

  private async post(html: string, mint: string, replyTo?: number): Promise<number | null> {
    this.sent++;
    let id: number | null = null;
    if (this.opts.telegram) id = await this.opts.telegram.bot.send(this.opts.telegram.chatId, html, { gmgnMint: mint, replyTo });
    if (this.opts.discord) {
      await this.opts.discord.http
        .json(this.opts.discord.webhookUrl, { body: { content: toPlain(html).slice(0, 1990) }, label: 'discord:webhook' })
        .catch((err) => this.log.warn({ err: String(err).slice(0, 200) }, 'discord send failed'));
    }
    return id;
  }

  /** "Bot is online" message, so you know a (re)start worked. */
  announce(html: string) {
    const tg = this.opts.telegram;
    if (tg) void tg.bot.send(tg.chatId, html);
  }

  /** Commands: paste a CA (or `/scan <CA>`) → full scan; `/open` → tracked signals. */
  startCommands() {
    const tg = this.opts.telegram;
    if (!tg) return;
    tg.bot.startPolling(tg.chatId, (text, chatId, msgId) => {
      const t = text.trim();
      if (/^\/(help|start)\b/.test(t)) {
        void tg.bot.send(chatId, HELP, { replyTo: msgId });
        return;
      }
      if (/^\/status\b/.test(t)) {
        void tg.bot.send(chatId, this.opts.status?.() ?? 'running', { replyTo: msgId });
        return;
      }
      if (/^\/open\b/.test(t)) {
        const lines = this.opts.positions?.openSummary() ?? [];
        void tg.bot.send(chatId, lines.length ? lines.join('\n') : 'No open signals.', { replyTo: msgId });
        return;
      }
      const mint = extractMints(t)[0];
      if (!mint || !this.opts.evaluator) return;
      void this.opts.evaluator
        .evaluate(mint, { deep: true, force: true })
        .then((ev) => tg.bot.send(chatId, formatScan(ev), { replyTo: msgId, gmgnMint: mint }))
        .catch((err) => tg.bot.send(chatId, `Scan failed: ${String(err).slice(0, 200)}`, { replyTo: msgId }));
    });
  }
}

export const HELP = [
  '<b>Memecoin scanner</b>',
  '• Paste any token CA (or <code>/scan CA</code>) → full safety scan + verdict',
  '• <code>/status</code> → is the bot healthy, what it is watching',
  '• <code>/open</code> → signals being tracked (sell updates arrive as replies to each alert)',
  '<i>Rule-based signals, not financial advice.</i>',
].join('\n');

/** Setup helper: before TELEGRAM_ALERT_CHAT_ID is set, answer any message with its chat id. */
export function startChatIdHelper(bot: TelegramBot) {
  bot.startPolling(null, (_text, chatId, msgId) => {
    void bot.send(chatId, `👋 Your chat id is <code>${chatId}</code>\nSet <code>TELEGRAM_ALERT_CHAT_ID=${chatId}</code> and restart the bot.`, { replyTo: msgId });
  });
}
