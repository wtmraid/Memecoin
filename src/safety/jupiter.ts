import { HttpError, type HttpClient } from '../core/http.js';
import { WSOL_MINT } from '../ingest/onchain/programs.js';

/** Jupiter Developer Platform. lite-api.jup.ag is being retired — not used. */
const QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';

export interface SellSimResult {
  /** A sell route exists. false = no route (possible honeypot / no liquidity). */
  routable: boolean;
  /** Round-trip loss %: buy `sizeSol` then sell the tokens back, incl. fees and impact. */
  roundTripLossPct: number | null;
  sellPriceImpactPct: number | null;
  error?: string;
}

interface Quote {
  outAmount: string;
  priceImpactPct?: string;
  routePlan?: unknown[];
}

/**
 * Honeypot check: quote a BUY of `sizeSol`, then quote SELLING exactly the tokens that
 * buy would return. A normal token loses only fees + impact (a few %); a honeypot or a
 * hidden sell tax shows up as no route or a large loss. Two quote calls (1 rps on free).
 */
export class JupiterSellSim {
  constructor(
    private http: HttpClient,
    private apiKey?: string,
  ) {}

  private quote(inputMint: string, outputMint: string, amount: bigint): Promise<Quote> {
    const qs = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: '1500',
      restrictIntermediateTokens: 'true',
    });
    return this.http.json<Quote>(`${QUOTE_URL}?${qs}`, {
      headers: this.apiKey ? { 'x-api-key': this.apiKey } : {},
      label: 'jupiter:quote',
      retries: 1,
    });
  }

  async simulate(mint: string, sizeSol: number): Promise<SellSimResult> {
    const lamports = BigInt(Math.round(sizeSol * 1e9));
    let buy: Quote;
    try {
      buy = await this.quote(WSOL_MINT, mint, lamports);
    } catch (err) {
      return { routable: false, roundTripLossPct: null, sellPriceImpactPct: null, error: noRoute(err) };
    }
    const tokens = BigInt(buy.outAmount ?? '0');
    if (tokens === 0n) return { routable: false, roundTripLossPct: null, sellPriceImpactPct: null, error: 'buy quote returned 0' };
    try {
      const sell = await this.quote(mint, WSOL_MINT, tokens);
      return evaluateRoundTrip(lamports, BigInt(sell.outAmount ?? '0'), sell.priceImpactPct);
    } catch (err) {
      return { routable: false, roundTripLossPct: null, sellPriceImpactPct: null, error: noRoute(err) };
    }
  }
}

/** Pure: lamports in vs lamports back → result. */
export function evaluateRoundTrip(lamportsIn: bigint, lamportsBack: bigint, priceImpact?: string): SellSimResult {
  if (lamportsBack === 0n) return { routable: false, roundTripLossPct: null, sellPriceImpactPct: null, error: 'sell quote returned 0' };
  const loss = (1 - Number(lamportsBack) / Number(lamportsIn)) * 100;
  const impact = priceImpact !== undefined && priceImpact !== '' ? Number(priceImpact) * 100 : null;
  return {
    routable: true,
    roundTripLossPct: Math.round(loss * 100) / 100,
    sellPriceImpactPct: impact !== null && Number.isFinite(impact) ? Math.round(impact * 100) / 100 : null,
  };
}

/**
 * A 4xx from Jupiter (e.g. "No routes found") is a real result: nobody can sell this.
 * Network errors, 429 and 5xx mean Jupiter is unavailable — rethrown so the check is
 * reported as "unknown" (and retried later) instead of being mistaken for a honeypot.
 */
function noRoute(err: unknown): string {
  if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) return `HTTP ${err.status}: ${err.body.slice(0, 120)}`;
  throw err;
}
