import WebSocket from 'ws';
import type { Logger } from '../../core/logger.js';
import type { LogNotification } from '../../core/types.js';

interface SubSpec {
  method: string;
  unsubscribe: string;
  params: unknown[];
  notification: string;
  onMessage: (result: unknown) => void;
  serverId: number | null;
}

export interface WsClientOptions {
  url: string;
  logger: Logger;
  pingIntervalMs?: number;
  /** Max backoff between reconnects. */
  maxBackoffMs?: number;
  /** If no message arrives for this long, the socket is assumed dead and recycled. */
  staleAfterMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Solana JSON-RPC WebSocket client that survives disconnects: it reconnects with
 * exponential backoff and re-issues every subscription. Helius closes idle sockets
 * after ~10 min, so we ping and also recycle sockets that go silent.
 */
export class SolanaWsClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private subs = new Map<number, SubSpec>(); // local id → spec
  private byServerId = new Map<number, SubSpec>();
  private pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  private backoff = 500;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = Date.now();
  public reconnects = 0;

  constructor(private opts: WsClientOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.opts.url);
    this.ws = ws;
    ws.on('open', () => {
      this.opts.logger.info({ subs: this.subs.size }, 'ws connected');
      this.backoff = 500;
      this.lastMessageAt = Date.now();
      this.byServerId.clear();
      for (const [localId, spec] of this.subs) this.sendSubscribe(localId, spec);
      this.startPing();
    });
    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      this.handle(data.toString());
    });
    ws.on('pong', () => (this.lastMessageAt = Date.now()));
    ws.on('error', (err) => this.opts.logger.warn({ err: err.message }, 'ws error'));
    ws.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      for (const spec of this.subs.values()) spec.serverId = null;
      this.pending.clear(); // in-flight subscribes are re-sent on reconnect
      if (this.closed) return;
      this.reconnects++;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 30_000);
      this.opts.logger.warn({ delay }, 'ws closed, reconnecting');
      setTimeout(() => !this.closed && this.connect(), delay);
    });
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const every = this.opts.pingIntervalMs ?? 30_000;
    const stale = this.opts.staleAfterMs ?? 120_000;
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > stale) {
        this.opts.logger.warn('ws stale, recycling');
        this.ws.terminate();
        return;
      }
      this.ws.ping();
    }, every);
  }

  private handle(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const cb = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      cb(msg);
      return;
    }
    if (msg.method && msg.params) {
      const spec = this.byServerId.get(msg.params.subscription);
      if (spec && spec.notification === msg.method) spec.onMessage(msg.params.result);
    }
  }

  private sendSubscribe(localId: number, spec: SubSpec) {
    const id = this.nextId++;
    this.pending.set(id, (resp) => {
      if (typeof resp.result === 'number') {
        spec.serverId = resp.result;
        this.byServerId.set(resp.result, spec);
      } else {
        this.opts.logger.error({ method: spec.method, error: resp.error, localId }, 'subscribe failed');
      }
    });
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method: spec.method, params: spec.params }));
  }

  /** Register a subscription; it is (re)sent on every connect. Returns an unsubscribe fn. */
  subscribe(
    method: string,
    params: unknown[],
    onMessage: (result: unknown) => void,
    notification = method.replace('Subscribe', 'Notification'),
  ): () => void {
    const localId = this.nextId++;
    const spec: SubSpec = {
      method,
      unsubscribe: method.replace('Subscribe', 'Unsubscribe'),
      params,
      notification,
      onMessage,
      serverId: null,
    };
    this.subs.set(localId, spec);
    if (this.connected) this.sendSubscribe(localId, spec);
    return () => {
      this.subs.delete(localId);
      if (spec.serverId !== null && this.connected) {
        this.byServerId.delete(spec.serverId);
        this.ws!.send(
          JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: spec.unsubscribe, params: [spec.serverId] }),
        );
      }
    };
  }

  /** `logsSubscribe` for one address (the RPC only accepts a single `mentions` entry). */
  onLogs(address: string, cb: (n: LogNotification) => void, commitment = 'confirmed'): () => void {
    return this.subscribe('logsSubscribe', [{ mentions: [address] }, { commitment }], (result: any) => {
      const v = result?.value;
      if (!v?.signature) return;
      cb({ signature: v.signature, slot: result.context?.slot ?? 0, err: v.err, logs: v.logs ?? [] });
    });
  }
}
