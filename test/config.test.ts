import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

describe('loadConfig', () => {
  it('builds Helius URLs from the key and loads default settings', () => {
    const cfg = loadConfig({ HELIUS_API_KEY: 'abc', CONFIG_PATH: './config/default.json' });
    expect(cfg.rpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=abc');
    expect(cfg.wsUrl).toBe('wss://mainnet.helius-rpc.com/?api-key=abc');
    expect(cfg.settings.ingest.venues).toContain('pumpfun');
    expect(cfg.env.ENABLE_REDDIT).toBe(false);
    expect(cfg.env.X_PROVIDER).toBe('off');
  });

  it('custom RPC overrides Helius; csv and booleans parse', () => {
    const cfg = loadConfig({
      HELIUS_API_KEY: 'abc',
      SOLANA_RPC_URL: 'https://rpc.example.com',
      SOLANA_WS_URL: 'wss://rpc.example.com',
      SMART_WALLETS: ' a, b ,,c',
      ENABLE_REDDIT: 'true',
      CONFIG_PATH: './does-not-exist.json',
    });
    expect(cfg.rpcUrl).toBe('https://rpc.example.com');
    expect(cfg.env.SMART_WALLETS).toEqual(['a', 'b', 'c']);
    expect(cfg.env.ENABLE_REDDIT).toBe(true);
    expect(cfg.settings.ingest.dexscreenerReqPerMin).toBe(250);
  });

  it('empty values (as saved by hosting dashboards) are treated as not set', () => {
    const cfg = loadConfig({ DISCORD_WEBHOOK_URL: '', SOLANA_RPC_URL: '', X_PROVIDER: '', TELEGRAM_ALERT_CHAT_ID: ' ', HELIUS_API_KEY: 'k', CONFIG_PATH: './config/default.json' });
    expect(cfg.env.DISCORD_WEBHOOK_URL).toBeUndefined();
    expect(cfg.env.X_PROVIDER).toBe('off');
    expect(cfg.env.TELEGRAM_ALERT_CHAT_ID).toBeUndefined();
    expect(cfg.rpcUrl).toContain('helius');
  });

  it('rejects an unknown X provider', () => {
    expect(() => loadConfig({ X_PROVIDER: 'scrape' })).toThrow();
  });
});
