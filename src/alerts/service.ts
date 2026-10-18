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
      minScore: number;
    },
  ) {
    bus.on('signal.buy', (s) => {
      if (s.score.score < opts.minScore) return;
      const html = formatSignal(s);
      void this.post(html, s.mint).then((id) => id && this.threads.set(s.id, id));
    });
    bus.on('signal.update', (u) => void this.post(formatUpdate(u), u.mint, this.threads.get(u.signalId)));
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

  /** Commands: paste a CA (or `/scan <CA>`) → full scan; `/open` → tracked signals. */
  startCommands() {
    const tg = this.opts.telegram;
    if (!tg) return;
    tg.bot.startPolling(tg.chatId, (text, chatId, msgId) => {
      const t = text.trim();
      if (/^\/(help|start)\b/.test(t)) {
        void tg.bot.send(chatId, 'Paste a token CA (or <code>/scan CA</code>) for a full safety scan.\n<code>/open</code> lists signals being tracked.', { replyTo: msgId });
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
