import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';

const PDA_MARKER = Buffer.from('ProgramDerivedAddress');

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Solana `findProgramAddress`: highest bump (255 → 0) whose
 * sha256(seeds ‖ bump ‖ programId ‖ "ProgramDerivedAddress") is NOT a valid ed25519 point.
 * Pure address math — no keys, no signing (replaces @solana/web3.js for this one use).
 */
export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] {
  const program = bs58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)).update(program).update(PDA_MARKER);
    const out = h.digest();
    if (!isOnCurve(out)) return [bs58.encode(out), bump];
  }
  throw new Error('no viable PDA bump');
}
