import type { SolanaRpc } from '../ingest/onchain/rpc.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: bigint;
  isToken2022: boolean;
  /** Token-2022 extensions present (names as in jsonParsed, e.g. `transferFeeConfig`). */
  extensions: string[];
  /** Current transfer fee in bps (Token-2022 TransferFeeConfig), 0 if none. */
  transferFeeBps: number;
  /** Extensions that let someone other than you move, freeze or block your tokens. */
  dangerous: string[];
}

/**
 * Extensions that make a token unsafe to hold regardless of anything else:
 * - permanentDelegate: issuer can transfer/burn anyone's tokens
 * - transferHook: arbitrary program runs on every transfer (can block sells)
 * - nonTransferable: you can't sell
 * - defaultAccountState=frozen: new accounts start frozen
 * - pausableConfig: issuer can halt all transfers
 */
const DANGEROUS = new Set(['permanentDelegate', 'transferHook', 'nonTransferable', 'pausableConfig']);

/** Pure: jsonParsed mint account → MintInfo. */
export function parseMintAccount(acc: { owner: string; data: { parsed?: { info?: any } } }): MintInfo {
  const info = acc.data.parsed?.info ?? {};
  const exts: { extension: string; state?: any }[] = Array.isArray(info.extensions) ? info.extensions : [];
  const names = exts.map((e) => e.extension);
  const dangerous = names.filter((n) => DANGEROUS.has(n));
  const das = exts.find((e) => e.extension === 'defaultAccountState');
  if (das && String(das.state?.accountState ?? '').toLowerCase() === 'frozen') dangerous.push('defaultAccountState:frozen');
  const fee = exts.find((e) => e.extension === 'transferFeeConfig');
  const transferFeeBps = Number(fee?.state?.newerTransferFee?.transferFeeBasisPoints ?? fee?.state?.olderTransferFee?.transferFeeBasisPoints ?? 0) || 0;
  return {
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    decimals: Number(info.decimals ?? 0),
    supply: BigInt(info.supply ?? '0'),
    isToken2022: acc.owner === TOKEN_2022_PROGRAM,
    extensions: names,
    transferFeeBps,
    dangerous,
  };
}

export async function fetchMintInfo(rpc: SolanaRpc, mint: string): Promise<MintInfo | null> {
  const r = await rpc.call<{ value: { owner: string; data: { parsed?: { info?: unknown } } } | null }>('getAccountInfo', [
    mint,
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  return r.value ? parseMintAccount(r.value) : null;
}
