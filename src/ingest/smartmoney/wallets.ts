import type { EventBus } from '../../core/bus.js';
import type { Logger } from '../../core/logger.js';
import { SeenSet } from '../../core/lru.js';
import type { WalletTrade } from '../../core/types.js';
import type { LogSource } from '../onchain/ingestor.js';
import { USDC_MINT, USDT_MINT, WSOL_MINT } from '../onchain/programs.js';
import type { ParsedTx, SolanaRpc } from '../onchain/rpc.js';

const STABLES = new Set([USDC_MINT, USDT_MINT]);
/** Ignore SOL moves smaller than this (fees, rent dust) when classifying a trade. */
const MIN_SOL_MOVE = 100_000n; // 0.0001 SOL

/**
 * DEX-agnostic: diff the wallet's own token and SOL balances across the tx.
 * Token up while SOL/stables down = buy; token down while SOL/stables up = sell.
 * Plain transfers (no counter-asset movement) are ignored.
 */
export function detectWalletTrades(tx: ParsedTx, wallet: string, signature: string): WalletTrade[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.pubkey === wallet);

  let solDelta = 0n;
  if (idx >= 0) {
    solDelta = BigInt(meta.postBalances[idx] ?? 0) - BigInt(meta.preBalances[idx] ?? 0);
    if (idx === 0) solDelta += BigInt(meta.fee); // fee isn't part of the trade
  }

  const deltas = new Map<string, bigint>();
  const add = (mint: string, v: bigint) => deltas.set(mint, (deltas.get(mint) ?? 0n) + v);
  for (const b of meta.preTokenBalances ?? []) if (b.owner === wallet) add(b.mint, -BigInt(b.uiTokenAmount.amount));
  for (const b of meta.postTokenBalances ?? []) if (b.owner === wallet) add(b.mint, BigInt(b.uiTokenAmount.amount));

  solDelta += deltas.get(WSOL_MINT) ?? 0n;
  deltas.delete(WSOL_MINT);
  let stableDelta = 0n;
  for (const s of STABLES) {
    stableDelta += deltas.get(s) ?? 0n;
    deltas.delete(s);
  }

  const paid = solDelta <= -MIN_SOL_MOVE || stableDelta < 0n;
  const received = solDelta >= MIN_SOL_MOVE || stableDelta > 0n;
  const ts = tx.blockTime ? tx.blockTime * 1000 : Date.now();
  const out: WalletTrade[] = [];
  for (const [mint, d] of deltas) {
    if (d === 0n) continue;
    const side = d > 0n && paid ? 'buy' : d < 0n && received ? 'sell' : null;
    if (!side) continue;
    out.push({ wallet, mint, side, tokenDelta: d, solDeltaLamports: solDelta, signature, slot: tx.slot, ts });
  }
  return out;
}

/** One logsSubscribe per wallet (RPC allows a single `mentions` address). */
export class SmartWalletWatcher {
  private seen = new SeenSet();
  private unsubs: (() => void)[] = [];
  constructor(
    private source: LogSource,
    private rpc: SolanaRpc,
    private bus: EventBus,
    private log: Logger,
    private wallets: string[],
  ) {}

  start() {
    for (const w of this.wallets) {
      this.unsubs.push(
        this.source.onLogs(w, (n) => {
          if (n.err || !this.seen.add(n.signature)) return;
          void this.rpc
            .getTransaction(n.signature)
            .then((tx) => {
              if (!tx) return;
              for (const t of detectWalletTrades(tx, w, n.signature)) this.bus.emit('wallet.trade', t);
            })
            .catch((err) => this.log.warn({ wallet: w, err: String(err) }, 'wallet tx fetch failed'));
        }),
      );
    }
    this.log.info({ wallets: this.wallets.length }, 'smart wallet watcher started');
  }

  stop() {
    this.unsubs.forEach((u) => u());
  }
}
