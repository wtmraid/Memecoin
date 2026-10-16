import type { SocialMention } from '../../core/types.js';
import type { Logger } from '../../core/logger.js';
import { extractMints, extractTickers } from './extract.js';

export interface TgMessageLike {
  id: number;
  text: string;
  chat: string;
  sender: string;
  date: number; // unix seconds
}

/** Pure: Telegram message → mention (or null if it names no token). */
export function mapTelegramMessage(m: TgMessageLike, kolChats: Set<string>): SocialMention | null {
  const mints = extractMints(m.text);
  const tickers = extractTickers(m.text);
  if (!mints.length && !tickers.length) return null;
  return {
    source: 'telegram',
    id: `${m.chat}:${m.id}`,
    author: m.sender,
    channel: m.chat,
    text: m.text.slice(0, 2000),
    mints,
    tickers,
    isKol: kolChats.has(m.chat.toLowerCase()),
    ts: m.date * 1000,
  };
}

/**
 * MTProto *user* client (GramJS), read-only: listens for new messages in channels /
 * groups the account has joined. Never sends. Create TELEGRAM_SESSION once with
 * `npm run telegram:login`.
 */
export async function startTelegram(opts: {
  apiId: number;
  apiHash: string;
  session: string;
  channels: string[];
  kolChannels: string[];
  log: Logger;
  onMention: (m: SocialMention) => void;
}): Promise<() => Promise<void>> {
  // Lazy import: GramJS is heavy and only needed when Telegram is enabled.
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions/index.js');
  const { NewMessage } = await import('telegram/events/index.js');

  const client = new TelegramClient(new StringSession(opts.session), opts.apiId, opts.apiHash, {
    connectionRetries: 10,
    floodSleepThreshold: 120,
  });
  client.setLogLevel('error' as never);
  await client.connect();
  if (!(await client.checkAuthorization())) throw new Error('Telegram session invalid — run npm run telegram:login');

  const kol = new Set(opts.kolChannels.map((c) => c.toLowerCase()));
  client.addEventHandler(
    async (ev: any) => {
      try {
        const msg = ev.message;
        const chat: any = await msg.getChat().catch(() => null);
        const chatName: string = chat?.username ?? String(msg.chatId ?? 'unknown');
        const sender: any = await msg.getSender().catch(() => null);
        const m = mapTelegramMessage(
          {
            id: msg.id,
            text: msg.message ?? '',
            chat: chatName,
            sender: sender?.username ?? String(msg.senderId ?? chatName),
            date: msg.date,
          },
          kol,
        );
        if (m) opts.onMention(m);
      } catch (err) {
        opts.log.warn({ err: String(err) }, 'telegram handler error');
      }
    },
    new NewMessage({ chats: opts.channels.length ? opts.channels : undefined }),
  );
  opts.log.info({ channels: opts.channels.length }, 'telegram listening');
  return async () => {
    await client.disconnect();
  };
}
