import { createHash } from 'node:crypto';
import { BorshReader } from './borsh.js';
import { programDataFor } from './logs.js';
import { PUMP_CURVE_INITIAL_REAL_TOKEN_RESERVES } from './programs.js';
import type { LogNotification, PumpComplete, PumpMigrated, PumpTrade, TokenCreated } from '../../core/types.js';

/** Anchor event discriminator: sha256("event:<Name>")[0..8]. */
export function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

export const DISC = {
  create: eventDiscriminator('CreateEvent'),
  trade: eventDiscriminator('TradeEvent'),
  complete: eventDiscriminator('CompleteEvent'),
  migration: eventDiscriminator('CompletePumpAmmMigrationEvent'),
};

export type PumpEvent =
  | { kind: 'create'; data: TokenCreated }
  | { kind: 'trade'; data: PumpTrade }
  | { kind: 'complete'; data: PumpComplete }
  | { kind: 'migration'; data: PumpMigrated };

const tsMs = (secs: bigint, fallback: number) => (secs > 0n ? Number(secs) * 1000 : fallback);

/*
 * Layouts follow github.com/pump-fun/pump-public-docs IDLs. pump.fun appends fields
 * over time, so each decoder reads the stable prefix and ignores trailing bytes.
 * Optional later fields are read only if enough bytes remain.
 */

function decodeCreate(r: BorshReader, ctx: Ctx): TokenCreated {
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  const user = r.pubkey();
  // `creator` was added after `user`; older events end here.
  const creator = r.remaining >= 32 ? r.pubkey() : user;
  const ts = r.remaining >= 8 ? r.i64() : 0n;
  return {
    mint,
    name,
    symbol,
    uri,
    bondingCurve,
    creator,
    venue: 'pumpfun',
    signature: ctx.signature,
    slot: ctx.slot,
    ts: tsMs(ts, ctx.now),
  };
}

function decodeTrade(r: BorshReader, ctx: Ctx): PumpTrade {
  const mint = r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const user = r.pubkey();
  const ts = r.i64();
  const virtualSolReserves = r.u64();
  const virtualTokenReserves = r.u64();
  const realSolReserves = r.remaining >= 8 ? r.u64() : undefined;
  const realTokenReserves = r.remaining >= 8 ? r.u64() : undefined;
  return {
    mint,
    user,
    isBuy,
    solAmount,
    tokenAmount,
    virtualSolReserves,
    virtualTokenReserves,
    realSolReserves,
    realTokenReserves,
    signature: ctx.signature,
    slot: ctx.slot,
    ts: tsMs(ts, ctx.now),
  };
}

function decodeComplete(r: BorshReader, ctx: Ctx): PumpComplete {
  const user = r.pubkey();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  const ts = r.remaining >= 8 ? r.i64() : 0n;
  return { user, mint, bondingCurve, signature: ctx.signature, slot: ctx.slot, ts: tsMs(ts, ctx.now) };
}

function decodeMigration(r: BorshReader, ctx: Ctx): PumpMigrated {
  r.pubkey(); // user
  const mint = r.pubkey();
  r.u64(); // mint_amount
  r.u64(); // sol_amount
  r.u64(); // pool_migration_fee
  r.pubkey(); // bonding_curve
  const ts = r.i64();
  const pool = r.remaining >= 32 ? r.pubkey() : undefined;
  return { mint, pool, signature: ctx.signature, slot: ctx.slot, ts: tsMs(ts, ctx.now) };
}

interface Ctx {
  signature: string;
  slot: number;
  now: number;
}

export function decodePumpEvent(buf: Buffer, ctx: Ctx): PumpEvent | null {
  if (buf.length < 8) return null;
  const disc = buf.subarray(0, 8);
  const r = new BorshReader(buf.subarray(8));
  try {
    if (disc.equals(DISC.create)) return { kind: 'create', data: decodeCreate(r, ctx) };
    if (disc.equals(DISC.trade)) return { kind: 'trade', data: decodeTrade(r, ctx) };
    if (disc.equals(DISC.complete)) return { kind: 'complete', data: decodeComplete(r, ctx) };
    if (disc.equals(DISC.migration)) return { kind: 'migration', data: decodeMigration(r, ctx) };
  } catch {
    return null; // truncated / layout changed — caller counts these
  }
  return null;
}

/** Decode every pump.fun event in a logs notification. Failed transactions yield nothing. */
export function decodePumpLogs(n: LogNotification, programId: string, now = Date.now()): PumpEvent[] {
  if (n.err) return [];
  const ctx = { signature: n.signature, slot: n.slot, now };
  return programDataFor(n.logs, programId)
    .map((b) => decodePumpEvent(b, ctx))
    .filter((e): e is PumpEvent => e !== null);
}

/** Share of curve tokens sold, 0..1. Clamped: pump.fun's final buy may overshoot. */
export function curveProgress(realTokenReserves: bigint): number {
  const initial = PUMP_CURVE_INITIAL_REAL_TOKEN_RESERVES;
  if (realTokenReserves >= initial) return 0;
  if (realTokenReserves <= 0n) return 1;
  return Number(initial - realTokenReserves) / Number(initial);
}

/** SOL per whole token implied by virtual reserves (SOL 9 decimals, token 6 decimals). */
export function curvePriceSol(virtualSolReserves: bigint, virtualTokenReserves: bigint): number {
  if (virtualTokenReserves === 0n) return 0;
  return Number(virtualSolReserves) / 1e9 / (Number(virtualTokenReserves) / 1e6);
}
