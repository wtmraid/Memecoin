import bs58 from 'bs58';
import pino from 'pino';
import { BorshWriter } from '../src/ingest/onchain/borsh.js';
import { DISC } from '../src/ingest/onchain/pumpfun.js';
import type { ParsedTokenBalance, ParsedTx } from '../src/ingest/onchain/rpc.js';

export const silent = pino({ level: 'silent' });

/** Deterministic distinct 32-byte pubkey for fixtures. */
export const key = (n: number) => bs58.encode(Buffer.alloc(32, n));

export const MINT = key(7);
export const CURVE = key(8);
export const USER = key(9);
export const CREATOR = key(10);

export function createEventData(o: { trailing?: Buffer; withCreator?: boolean } = {}) {
  const w = new BorshWriter().raw(DISC.create).string('Dog Wif Test').string('DWT').string('https://ipfs.io/x');
  w.pubkey(MINT).pubkey(CURVE).pubkey(USER);
  if (o.withCreator !== false) {
    w.pubkey(CREATOR).i64(1_760_000_000n);
    w.u64(1_073_000_000_000_000n).u64(30_000_000_000n).u64(793_100_000_000_000n).u64(1_000_000_000_000_000n);
  }
  if (o.trailing) w.raw(o.trailing);
  return w.build();
}

export function tradeEventData(o: { isBuy?: boolean; realToken?: bigint } = {}) {
  return new BorshWriter()
    .raw(DISC.trade)
    .pubkey(MINT)
    .u64(1_000_000_000n) // 1 SOL
    .u64(35_000_000_000_000n)
    .bool(o.isBuy ?? true)
    .pubkey(USER)
    .i64(1_760_000_100n)
    .u64(31_000_000_000n)
    .u64(1_038_000_000_000_000n)
    .u64(1_000_000_000n)
    .u64(o.realToken ?? 758_100_000_000_000n)
    .raw(Buffer.alloc(64)) // appended fields we don't read (fee recipient, fees, …)
    .build();
}

export function completeEventData() {
  return new BorshWriter().raw(DISC.complete).pubkey(USER).pubkey(MINT).pubkey(CURVE).i64(1_760_000_200n).build();
}

export function migrationEventData(pool = key(11)) {
  return new BorshWriter()
    .raw(DISC.migration)
    .pubkey(USER)
    .pubkey(MINT)
    .u64(206_900_000_000_000n)
    .u64(84_990_000_000n)
    .u64(15_000_000n)
    .pubkey(CURVE)
    .i64(1_760_000_300n)
    .pubkey(pool)
    .build();
}

/** Wrap `Program data:` payloads in a realistic invoke frame of `programId`. */
export function logsFor(programId: string, payloads: Buffer[], extra: string[] = []): string[] {
  return [
    'Program ComputeBudget111111111111111111111111111111 invoke [1]',
    'Program ComputeBudget111111111111111111111111111111 success',
    `Program ${programId} invoke [1]`,
    ...extra,
    ...payloads.map((p) => `Program data: ${p.toString('base64')}`),
    `Program ${programId} consumed 50000 of 200000 compute units`,
    `Program ${programId} success`,
  ];
}

export function tb(accountIndex: number, mint: string, owner: string, amount: bigint, decimals = 6): ParsedTokenBalance {
  return { accountIndex, mint, owner, uiTokenAmount: { amount: amount.toString(), decimals } };
}

export function parsedTx(p: {
  signers: string[];
  others?: string[];
  pre?: ParsedTokenBalance[];
  post?: ParsedTokenBalance[];
  preBalances?: number[];
  postBalances?: number[];
  fee?: number;
  err?: unknown;
}): ParsedTx {
  const keys = [
    ...p.signers.map((k) => ({ pubkey: k, signer: true, writable: true })),
    ...(p.others ?? []).map((k) => ({ pubkey: k, signer: false, writable: true })),
  ];
  return {
    slot: 123,
    blockTime: 1_760_000_000,
    meta: {
      err: p.err ?? null,
      fee: p.fee ?? 5000,
      preBalances: p.preBalances ?? keys.map(() => 0),
      postBalances: p.postBalances ?? keys.map(() => 0),
      preTokenBalances: p.pre ?? [],
      postTokenBalances: p.post ?? [],
    },
    transaction: { message: { accountKeys: keys }, signatures: ['sig'] },
  };
}
