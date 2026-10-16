/** Rate-limited, retrying JSON HTTP client shared by every REST integration. */

export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  /**
   * @param ratePerSec sustained rate
   * @param burst max tokens stored
   */
  constructor(
    private ratePerSec: number,
    private burst: number = Math.max(1, Math.ceil(ratePerSec)),
    private now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }

  /** Try to take a token without waiting. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Resolves when a token is available. FIFO. */
  take(): Promise<void> {
    if (this.queue.length === 0 && this.tryTake()) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.schedule();
    });
  }

  private schedule() {
    if (this.timer) return;
    this.refill();
    const waitMs = this.tokens >= 1 ? 0 : ((1 - this.tokens) / this.ratePerSec) * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      while (this.queue.length && this.tryTake()) this.queue.shift()!();
      if (this.queue.length) this.schedule();
    }, Math.ceil(waitMs));
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public endpoint: string,
  ) {
    super(`HTTP ${status} from ${endpoint}: ${body.slice(0, 200)}`);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** application/x-www-form-urlencoded body (e.g. OAuth token endpoints). */
  form?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** For logs/errors: a label that never contains secrets. */
  label?: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  constructor(
    private bucket: TokenBucket,
    private fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private baseDelayMs = 500,
  ) {}

  async json<T>(url: string, opts: RequestOptions = {}): Promise<T> {
    const retries = opts.retries ?? 3;
    const label = opts.label ?? new URL(url).host;
    let attempt = 0;
    for (;;) {
      await this.bucket.take();
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
      try {
        const res = await this.fetchImpl(url, {
          method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
          headers: {
            accept: 'application/json',
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
            ...opts.headers,
          },
          body: opts.form
            ? new URLSearchParams(opts.form).toString()
            : opts.body !== undefined
              ? JSON.stringify(opts.body)
              : undefined,
          signal: ctrl.signal,
        });
        if (res.ok) return (await res.json()) as T;
        const text = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= retries) throw new HttpError(res.status, text, label);
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : this.baseDelayMs * 2 ** attempt;
        await sleep(delay);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (attempt >= retries) throw err;
        await sleep(this.baseDelayMs * 2 ** attempt);
      } finally {
        clearTimeout(to);
      }
      attempt++;
    }
  }
}
