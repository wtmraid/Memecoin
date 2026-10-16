import pino from 'pino';

const pretty = process.env.LOG_PRETTY === 'true';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Never log full RPC URLs: Helius keys live in the query string.
  redact: { paths: ['url', 'rpcUrl', 'wsUrl', '*.apiKey', '*.token'], censor: '[redacted]' },
  ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
});

export type Logger = typeof logger;
