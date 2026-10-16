import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, TokenBucket } from '../src/core/http.js';

describe('TokenBucket', () => {
  it('allows a burst, then refills at the configured rate', () => {
    let t = 0;
    const b = new TokenBucket(2, 2, () => t);
    expect([b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, false]);
    t = 499;
    expect(b.tryTake()).toBe(false);
    t = 500;
    expect(b.tryTake()).toBe(true);
  });

  it('take() resolves queued waiters in order', async () => {
    const b = new TokenBucket(100, 1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => b.take().then(() => order.push(i))));
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('HttpClient', () => {
  const bucket = () => new TokenBucket(1000, 1000);

  it('retries 429 and 5xx, then succeeds', async () => {
    const statuses = [429, 503, 200];
    let calls = 0;
    const http = new HttpClient(
      bucket(),
      async () => {
        const s = statuses[calls++]!;
        return new Response(s === 200 ? '{"ok":true}' : 'slow down', { status: s });
      },
      1,
    );
    expect(await http.json('https://x.test/a')).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('does not retry 4xx client errors', async () => {
    let calls = 0;
    const http = new HttpClient(bucket(), async () => {
      calls++;
      return new Response('bad', { status: 400 });
    });
    await expect(http.json('https://x.test/a')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('gives up after max retries', async () => {
    let calls = 0;
    const http = new HttpClient(
      bucket(),
      async () => {
        calls++;
        return new Response('', { status: 500 });
      },
      1,
    );
    await expect(http.json('https://x.test/a', { retries: 2 })).rejects.toThrow('HTTP 500');
    expect(calls).toBe(3);
  });

  it('sends form bodies as urlencoded POST', async () => {
    let seen: RequestInit | undefined;
    const http = new HttpClient(bucket(), async (_u, init) => {
      seen = init;
      return new Response('{}', { status: 200 });
    });
    await http.json('https://x.test/token', { form: { grant_type: 'client_credentials' } });
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('grant_type=client_credentials');
    expect((seen?.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
  });
});
