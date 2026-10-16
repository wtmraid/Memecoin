import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { SolanaWsClient } from '../src/ingest/onchain/wsClient.js';
import type { LogNotification } from '../src/core/types.js';
import { silent } from './helpers.js';

/** Minimal fake of a Solana WS endpoint: answers logsSubscribe and lets the test push notifications. */
function fakeServer() {
  const wss = new WebSocketServer({ port: 0 });
  const sockets: WebSocket[] = [];
  let subCounter = 100;
  const subscribes: unknown[] = [];
  wss.on('connection', (s) => {
    sockets.push(s);
    s.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'logsSubscribe') {
        subscribes.push(msg.params);
        s.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: ++subCounter }));
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    subscribes,
    get lastSub() {
      return subCounter;
    },
    push(sub: number, value: object) {
      for (const s of sockets) {
        if (s.readyState === 1)
          s.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: sub, result: { context: { slot: 77 }, value } } }));
      }
    },
    dropAll() {
      sockets.forEach((s) => s.terminate());
    },
    close: () => new Promise((r) => wss.close(r)),
  };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

describe('SolanaWsClient', () => {
  it('subscribes, delivers notifications, and resubscribes after a drop', async () => {
    const srv = fakeServer();
    const client = new SolanaWsClient({ url: srv.url, logger: silent, maxBackoffMs: 50 });
    cleanup.push(() => client.stop(), () => srv.close());
    const got: LogNotification[] = [];
    client.onLogs('Prog1111', (n) => got.push(n));
    client.start();

    await until(() => srv.subscribes.length === 1);
    expect(srv.subscribes[0]).toEqual([{ mentions: ['Prog1111'] }, { commitment: 'confirmed' }]);
    await new Promise((r) => setTimeout(r, 20));
    srv.push(srv.lastSub, { signature: 'sigA', err: null, logs: ['x'] });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ signature: 'sigA', slot: 77, err: null, logs: ['x'] });

    srv.dropAll();
    await until(() => srv.subscribes.length === 2);
    expect(client.reconnects).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    srv.push(srv.lastSub, { signature: 'sigB', err: null, logs: [] });
    await until(() => got.length === 2);
    expect(got[1]!.signature).toBe('sigB');
  });

  it('ignores notifications for unknown subscriptions', async () => {
    const srv = fakeServer();
    const client = new SolanaWsClient({ url: srv.url, logger: silent });
    cleanup.push(() => client.stop(), () => srv.close());
    const got: unknown[] = [];
    client.onLogs('P', (n) => got.push(n));
    client.start();
    await until(() => srv.subscribes.length === 1);
    srv.push(999_999, { signature: 's', err: null, logs: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual([]);
  });
});
