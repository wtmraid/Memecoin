import { describe, expect, it } from 'vitest';
import { BorshReader, BorshWriter } from '../src/ingest/onchain/borsh.js';
import { frameLogs, programDataFor } from '../src/ingest/onchain/logs.js';
import { PROGRAM_IDS } from '../src/ingest/onchain/programs.js';
import { curvePriceSol, curveProgress, decodePumpEvent, decodePumpLogs, DISC } from '../src/ingest/onchain/pumpfun.js';
import { bondingCurvePda, decodeBondingCurve } from '../src/ingest/onchain/bondingCurve.js';
import {
  completeEventData,
  createEventData,
  CREATOR,
  CURVE,
  key,
  logsFor,
  migrationEventData,
  MINT,
  tradeEventData,
  USER,
} from './helpers.js';

const PUMP = PROGRAM_IDS.pumpfun;
const ctx = { signature: 'sig1', slot: 42, now: 1 };

describe('Anchor event discriminators', () => {
  it('match the bytes seen on mainnet (TradeEvent = vdt/007mYe…)', () => {
    expect(DISC.trade.toString('hex')).toBe('bddb7fd34ee661ee');
    expect(DISC.create.toString('hex')).toBe('1b72a94ddeeb6376');
    expect(DISC.complete.toString('hex')).toBe('5f72619cd42e9808');
  });
});

describe('borsh', () => {
  it('round-trips primitives', () => {
    const b = new BorshWriter().u8(3).bool(true).u32(9).u64(2n ** 63n).i64(-5n).string('héllo').pubkey(MINT).build();
    const r = new BorshReader(b);
    expect([r.u8(), r.bool(), r.u32(), r.u64(), r.i64(), r.string(), r.pubkey()]).toEqual([
      3, true, 9, 2n ** 63n, -5n, 'héllo', MINT,
    ]);
    expect(r.remaining).toBe(0);
  });
  it('throws on truncated input', () => {
    expect(() => new BorshReader(Buffer.alloc(3)).u64()).toThrow(RangeError);
  });
});

describe('log framing', () => {
  it('attributes lines to the innermost executing program', () => {
    const logs = [
      'Program A111 invoke [1]',
      'Program log: outer',
      'Program B222 invoke [2]',
      'Program log: inner',
      'Program B222 success',
      'Program log: outer again',
      'Program A111 success',
    ];
    expect(frameLogs(logs).map((f) => `${f.programId}:${f.line}`)).toEqual([
      'A111:Program log: outer',
      'B222:Program log: inner',
      'A111:Program log: outer again',
    ]);
  });
  it('ignores Program data emitted by a different program (spoof protection)', () => {
    const logs = logsFor(key(99), [createEventData()]);
    expect(programDataFor(logs, PUMP)).toHaveLength(0);
  });
});

describe('pump.fun event decoding', () => {
  it('decodes CreateEvent', () => {
    const ev = decodePumpEvent(createEventData(), ctx);
    expect(ev?.kind).toBe('create');
    if (ev?.kind !== 'create') return;
    expect(ev.data).toMatchObject({
      mint: MINT,
      name: 'Dog Wif Test',
      symbol: 'DWT',
      bondingCurve: CURVE,
      creator: CREATOR,
      venue: 'pumpfun',
      ts: 1_760_000_000_000,
    });
  });

  it('tolerates appended fields (IDL growth)', () => {
    const ev = decodePumpEvent(createEventData({ trailing: Buffer.alloc(100, 1) }), ctx);
    expect(ev?.kind).toBe('create');
  });

  it('handles legacy CreateEvent without creator (falls back to user)', () => {
    const ev = decodePumpEvent(createEventData({ withCreator: false }), ctx);
    expect(ev?.kind === 'create' && ev.data.creator).toBe(USER);
  });

  it('decodes TradeEvent buy and sell with reserves', () => {
    const buy = decodePumpEvent(tradeEventData(), ctx);
    expect(buy?.kind).toBe('trade');
    if (buy?.kind !== 'trade') return;
    expect(buy.data.isBuy).toBe(true);
    expect(buy.data.solAmount).toBe(1_000_000_000n);
    expect(buy.data.realTokenReserves).toBe(758_100_000_000_000n);
    const sell = decodePumpEvent(tradeEventData({ isBuy: false }), ctx);
    expect(sell?.kind === 'trade' && sell.data.isBuy).toBe(false);
  });

  it('decodes CompleteEvent and migration event', () => {
    const c = decodePumpEvent(completeEventData(), ctx);
    expect(c).toMatchObject({ kind: 'complete', data: { mint: MINT, bondingCurve: CURVE } });
    const m = decodePumpEvent(migrationEventData(key(11)), ctx);
    expect(m).toMatchObject({ kind: 'migration', data: { mint: MINT, pool: key(11) } });
  });

  it('returns null for unknown discriminator or truncated payload', () => {
    expect(decodePumpEvent(Buffer.alloc(40), ctx)).toBeNull();
    expect(decodePumpEvent(createEventData().subarray(0, 30), ctx)).toBeNull();
  });

  it('decodes all events from a logs notification, skipping failed txs', () => {
    const logs = logsFor(PUMP, [createEventData(), tradeEventData()]);
    expect(decodePumpLogs({ signature: 's', slot: 1, err: null, logs }, PUMP).map((e) => e.kind)).toEqual([
      'create',
      'trade',
    ]);
    expect(decodePumpLogs({ signature: 's', slot: 1, err: { InstructionError: [] }, logs }, PUMP)).toEqual([]);
  });
});

describe('bonding curve', () => {
  it('progress is share of curve tokens sold, clamped', () => {
    expect(curveProgress(793_100_000_000_000n)).toBe(0);
    expect(curveProgress(396_550_000_000_000n)).toBeCloseTo(0.5);
    expect(curveProgress(0n)).toBe(1);
    expect(curveProgress(900_000_000_000_000n)).toBe(0);
  });

  it('initial price ≈ 2.8e-8 SOL per token', () => {
    expect(curvePriceSol(30_000_000_000n, 1_073_000_000_000_000n)).toBeCloseTo(2.796e-8, 10);
  });

  it('decodes the account layout', () => {
    const data = new BorshWriter()
      .raw(Buffer.alloc(8))
      .u64(1_000_000_000_000_000n)
      .u64(32_000_000_000n)
      .u64(720_000_000_000_000n)
      .u64(2_000_000_000n)
      .u64(1_000_000_000_000_000n)
      .bool(false)
      .pubkey(CREATOR)
      .build();
    const c = decodeBondingCurve(MINT, data);
    expect(c.complete).toBe(false);
    expect(c.creator).toBe(CREATOR);
    expect(c.progress).toBeCloseTo((793.1 - 720) / 793.1);
  });

  it('derives a deterministic PDA', () => {
    const a = bondingCurvePda(MINT, PUMP);
    expect(a).toBe(bondingCurvePda(MINT, PUMP));
    expect(a).not.toBe(bondingCurvePda(key(12), PUMP));
  });
});
