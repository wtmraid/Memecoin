/**
 * One-time interactive login that prints a TELEGRAM_SESSION string for .env.
 * Use an aged personal account and your own api_id/api_hash from my.telegram.org.
 * The session string grants full access to that account — store it like a password.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const apiId = Number(process.env.TELEGRAM_API_ID ?? (await rl.question('api_id: ')));
const apiHash = process.env.TELEGRAM_API_HASH ?? (await rl.question('api_hash: '));

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
await client.start({
  phoneNumber: () => rl.question('phone (+countrycode): '),
  password: () => rl.question('2FA password (blank if none): '),
  phoneCode: () => rl.question('code from Telegram: '),
  onError: (err) => console.error(err),
});
console.log('\nTELEGRAM_SESSION=' + (client.session.save() as unknown as string));
await client.disconnect();
rl.close();
process.exit(0);
