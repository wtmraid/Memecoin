import { describe, expect, it } from 'vitest';
import { detectWalletTrades } from '../src/ingest/smartmoney/wallets.js';
import { USDC_MINT, WSOL_MINT } from '../src/ingest/onchain/programs.js';
import { key, parsedTx, tb } from './helpers.js';

const W = key(1);
const POOL = key(2);
const TOKEN = key(3);

describe('detectWalletTrades', () => {
  it('detects a SOL → token buy (fee excluded from trade size)', () => {
    const tx = parsedTx({
      signers: [W],
      others: [POOL],
      preBalances: [10_000_000_000, 0],
      postBalances: [8_999_995_000, 0], // -1 SOL - 5000 fee
      pre: [],
      post: [tb(3, TOKEN, W, 5_000_000n)],
    });
    expect(detectWalletTrades(tx, W, 'sig')).toEqual([
      expect.objectContaining({ side: 'buy', mint: TOKEN, tokenDelta: 5_000_000n, solDeltaLamports: -1_000_000_000n }),
    ]);
  });

  it('detects a token → SOL sell', () => {
    const tx = parsedTx({
      signers: [W],
      preBalances: [1_000_000_000],
      postBalances: [2_000_000_000],
      pre: [tb(3, TOKEN, W, 5_000_000n)],
      post: [tb(3, TOKEN, W, 0n)],
    });
    expect(detectWalletTrades(tx, W, 'sig')[0]).toMatchObject({ side: 'sell', tokenDelta: -5_000_000n });
  });

  it('counts WSOL token-account moves as SOL', () => {
    const tx = parsedTx({
      signers: [W],
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      pre: [tb(4, WSOL_MINT, W, 2_000_000_000n, 9)],
      post: [tb(4, WSOL_MINT, W, 1_000_000_000n, 9), tb(3, TOKEN, W, 7n)],
    });
    expect(detectWalletTrades(tx, W, 'sig')).toEqual([expect.objectContaining({ side: 'buy', mint: TOKEN })]);
  });

  it('detects a USDC-funded buy', () => {
    const tx = parsedTx({
      signers: [W],
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      pre: [tb(4, USDC_MINT, W, 100_000_000n)],
      post: [tb(4, USDC_MINT, W, 50_000_000n), tb(3, TOKEN, W, 7n)],
    });
    expect(detectWalletTrades(tx, W, 'sig')[0]).toMatchObject({ side: 'buy' });
  });

  it('ignores plain incoming transfers / airdrops', () => {
    const tx = parsedTx({
      signers: [key(9)],
      others: [W],
      preBalances: [1_000_000_000, 500],
      postBalances: [999_995_000, 500],
      post: [tb(3, TOKEN, W, 1_000n)],
    });
    expect(detectWalletTrades(tx, W, 'sig')).toEqual([]);
  });

  it('ignores failed transactions and other wallets\' balances', () => {
    expect(detectWalletTrades(parsedTx({ signers: [W], err: { x: 1 } }), W, 's')).toEqual([]);
    const tx = parsedTx({
      signers: [W],
      preBalances: [2_000_000_000],
      postBalances: [1_000_000_000],
      post: [tb(3, TOKEN, key(8), 1_000n)],
    });
    expect(detectWalletTrades(tx, W, 's')).toEqual([]);
  });
});
