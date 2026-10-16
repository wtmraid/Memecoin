import { PublicKey } from '@solana/web3.js';
import { BorshReader } from './borsh.js';
import { curvePriceSol, curveProgress } from './pumpfun.js';
import type { BondingCurveState } from '../../core/types.js';

export function bondingCurvePda(mint: string, programId: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(programId),
  );
  return pda.toBase58();
}

/**
 * pump.fun BondingCurve account: 8-byte discriminator, 5×u64 reserves/supply,
 * bool complete, then (newer accounts) creator pubkey. Trailing fields ignored.
 */
export function decodeBondingCurve(mint: string, data: Buffer): BondingCurveState {
  const r = new BorshReader(data);
  r.skip(8);
  const virtualTokenReserves = r.u64();
  const virtualSolReserves = r.u64();
  const realTokenReserves = r.u64();
  const realSolReserves = r.u64();
  const tokenTotalSupply = r.u64();
  const complete = r.bool();
  const creator = r.remaining >= 32 ? r.pubkey() : undefined;
  return {
    mint,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
    progress: complete ? 1 : curveProgress(realTokenReserves),
    priceSol: curvePriceSol(virtualSolReserves, virtualTokenReserves),
  };
}
