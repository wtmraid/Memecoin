import { HttpError, type HttpClient } from '../core/http.js';
import type { Logger } from '../core/logger.js';
import { gmgnUrl } from '../safety/gmgn.js';

export interface SendOptions {
  replyTo?: number;
  /** Adds an inline "Open on GMGN" button for this mint. */
  gmgnMint?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Telegram Bot API client with a serial send queue (≈1 msg/s per chat, Telegram's
 * guidance) that honours `retry_after` on 429. Also long-polls for /scan commands.
 */
export class TelegramBot {
  private queue: (() => Promise<void>)[] = [];
  private running = false;
  private offset = 0;
  private polling = false;

  constructor(
    private http: HttpClient,
    private token: string,
    private log: Logger,
    private minGapMs = 1100,
  ) {}

  private api<T>(method: string, body: object, timeoutMs = 15_000): Promise<{ ok: boolean; result: T; description?: string }> {
    return this.http.json(`https://api.telegram.org/bot${this.token}/${method}`, { body, label: `telegram:${method}`, timeoutMs, retries: 0 });
  }

  /** Queue a message. Resolves with the message_id (for threading replies), or null on failure. */
  send(chatId: string, html: string, opts: SendOptions = {}): Promise<number | null> {
    return new Promise((resolve) => {
      this.queue.push(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const r = await this.api<{ message_id: number }>('sendMessage', {
              chat_id: chatId,
              text: html.slice(0, 4096),
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}),
              ...(opts.gmgnMint
                ? { reply_markup: { inline_keyboard: [[{ text: '📈 Open on GMGN', url: gmgnUrl(opts.gmgnMint) }]] } }
                : {}),
            });
            resolve(r.result?.message_id ?? null);
            return;
          } catch (err) {
            const wait = retryAfterMs(err);
            if (wait !== null && attempt < 2) {
              await sleep(wait);
              continue;
            }
            this.log.warn({ err: String(err).slice(0, 200) }, 'telegram send failed');
            resolve(null);
            return;
          }
        }
      });
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      await this.queue.shift()!();
      await sleep(this.minGapMs);
    }
    this.running = false;
  }

  /**
   * Long-poll for messages from `allowedChatId` only (anyone else is ignored).
   * Calls `onText(text, chatId, messageId)`.
   */
  startPolling(allowedChatId: string, onText: (text: string, chatId: string, messageId: number) => void) {
    this.polling = true;
    const loop = async () => {
      while (this.polling) {
        try {
          const r = await this.api<{ update_id: number; message?: { message_id: number; chat: { id: number }; text?: string } }[]>(
            'getUpdates',
            { offset: this.offset, timeout: 25, allowed_updates: ['message'] },
            35_000,
          );
          for (const u of r.result ?? []) {
            this.offset = u.update_id + 1;
            const m = u.message;
            if (m?.text && String(m.chat.id) === allowedChatId) onText(m.text, String(m.chat.id), m.message_id);
          }
        } catch (err) {
          this.log.debug({ err: String(err).slice(0, 200) }, 'telegram poll error');
          await sleep(5000);
        }
      }
    };
    void loop();
  }

  stopPolling() {
    this.polling = false;
  }
}

function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof HttpError) || err.status !== 429) return null;
  try {
    const s = JSON.parse(err.body)?.parameters?.retry_after;
    return typeof s === 'number' ? s * 1000 + 250 : 5000;
  } catch {
    return 5000;
  }
}
