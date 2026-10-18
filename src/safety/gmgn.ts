import { randomUUID } from 'node:crypto';
import { HttpError, type HttpClient } from '../core/http.js';

/**
 * GMGN OpenAPI (https://openapi.gmgn.ai) — the same numbers GMGN's token page shows in
 * "Core Metrics". Auth: `X-APIKEY` header + `timestamp` (unix s, ±5 s) and `client_id`
 * (UUID, replay-protected) query params. Free plan leaky bucket ≈ 5 weight/s; info and
 * security weigh 1 each. IPv4 only. Docs: github.com/GMGNAI/gmgn-skills.
 */
export const GMGN_HOST = 'https://openapi.gmgn.ai';

/** The GMGN token page for a mint — the only external link the alerts use. */
export const gmgnUrl = (mint: string) => `https://gmgn.ai/sol/token/${mint}`;

export interface GmgnFacts {
  symbol: string | null;
  name: string | null;
  /** "Taxes" tile, % (max of buy/sell tax). */
  taxPct: number | null;
  /** "Top 10", %. */
  top10Pct: number | null;
  /** "Bundler", %. */
  bundlerPct: number | null;
  /** "Phishing wallet", % (GMGN calls it entrapment). */
  phishingPct: number | null;
  /** "Insiders", % (rat traders). */
  insiderPct: number | null;
  sniperCount: number | null;
  /** "Dev holdings", %. */
  devHoldPct: number | null;
  devTeamHoldPct: number | null;
  /** "Dev Migrated": creator's tokens that reached an open market. */
  devMigrated: number | null;
  devLaunches: number | null;
  /** "Rug", 0–1. */
  rugRatio: number | null;
  creatorStatus: 'hold' | 'sold' | 'closed' | null;
  creator: string | null;
  devFundedBy: string | null;
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  lpBurned: boolean | null;
  isWashTrading: boolean | null;
  holderCount: number | null;
  liquidityUsd: number | null;
  priceUsd: number | null;
  athPriceUsd: number | null;
  launchpad: string | null;
  launchpadStatus: 'curve' | 'migrated' | 'not_open' | null;
  launchpadProgress: number | null;
  smartWallets: number | null;
  renownedWallets: number | null;
  freshWalletPct: number | null;
  ctoFlag: boolean | null;
  imageDupCount: number | null;
  socials: { twitter?: string; website?: string; telegram?: string };
  gmgnLink: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
/** GMGN rates are 0–1 fractions; tiles show %. */
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 10_000) / 100;
};
const bool = (v: unknown): boolean | null => {
  if (v === true || v === 1 || v === 'yes' || v === 'true' || v === '1') return true;
  if (v === false || v === 0 || v === 'no' || v === 'false' || v === '0') return false;
  return null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const first = <T>(...vals: (T | null)[]): T | null => vals.find((v) => v !== null && v !== undefined) ?? null;

type Obj = Record<string, any>;

/** Pure: GMGN `token/info` + `token/security` payloads → the facts the bot uses. */
export function mapGmgn(mint: string, info: Obj | null, sec: Obj | null): GmgnFacts {
  const i = info ?? {};
  const s = sec ?? {};
  const stat = i.stat ?? {};
  const dev = i.dev ?? {};
  const link = i.link ?? {};
  const tags = i.wallet_tags_stat ?? {};
  const price = i.price ?? {};

  const buyTax = pct(s.buy_tax);
  const sellTax = pct(s.sell_tax);
  const taxes = [buyTax, sellTax].filter((x): x is number => x !== null);

  const statusRaw = String(first(str(s.creator_token_status), str(dev.creator_token_status)) ?? '');
  const creatorStatus = statusRaw.includes('hold') ? 'hold' : statusRaw.includes('sell') ? 'sold' : statusRaw.includes('close') ? 'closed' : null;

  const lp = num(i.launchpad_status);
  const twitter = str(link.twitter_username);

  return {
    symbol: str(i.symbol),
    name: str(i.name),
    taxPct: taxes.length ? Math.max(...taxes) : null,
    top10Pct: first(pct(stat.top_10_holder_rate), pct(s.top_10_holder_rate), pct(dev.top_10_holder_rate)),
    bundlerPct: first(pct(stat.top_bundler_trader_percentage), pct(s.bundler_trader_amount_rate)),
    phishingPct: first(pct(stat.top_entrapment_trader_percentage), pct(s.entrapment_ratio)),
    insiderPct: first(pct(stat.top_rat_trader_percentage), pct(s.rat_trader_amount_rate), pct(s.suspected_insider_hold_rate)),
    sniperCount: first(num(s.sniper_count), num(tags.sniper_wallets)),
    devHoldPct: first(pct(stat.creator_hold_rate), pct(s.creator_balance_rate)),
    devTeamHoldPct: first(pct(stat.dev_team_hold_rate), pct(s.dev_team_hold_rate)),
    devMigrated: num(dev.creator_open_count),
    devLaunches: null, // filled from created_tokens when fetched
    rugRatio: num(s.rug_ratio),
    creatorStatus,
    creator: str(dev.creator_address),
    devFundedBy: str(dev.fund_from),
    mintRenounced: bool(s.renounced_mint),
    freezeRenounced: bool(s.renounced_freeze_account),
    lpBurned: s.burn_status === undefined ? null : s.burn_status === 'burn',
    isWashTrading: bool(s.is_wash_trading),
    holderCount: first(num(i.holder_count), num(stat.holder_count)),
    liquidityUsd: num(i.liquidity),
    priceUsd: num(price.price),
    athPriceUsd: num(i.ath_price),
    launchpad: str(i.launchpad),
    launchpadStatus: lp === 1 ? 'curve' : lp === 2 ? 'migrated' : lp === 0 ? 'not_open' : null,
    launchpadProgress: num(i.launchpad_progress),
    smartWallets: num(tags.smart_wallets),
    renownedWallets: num(tags.renowned_wallets),
    freshWalletPct: pct(stat.fresh_wallet_rate),
    ctoFlag: bool(dev.cto_flag),
    imageDupCount: num(i.image_dup_count),
    socials: {
      twitter: twitter ? `https://x.com/${twitter.replace(/^@/, '')}` : undefined,
      website: str(link.website) ?? undefined,
      telegram: str(link.telegram) ?? undefined,
    },
    gmgnLink: str(link.gmgn) ?? gmgnUrl(mint),
  };
}

export class GmgnError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`GMGN ${code}: ${message}`);
  }
}

export class GmgnClient {
  /** After a RATE_LIMIT_BANNED we must stay silent until this time (more calls extend the ban). */
  private bannedUntil = 0;

  constructor(
    private http: HttpClient,
    private apiKey: string,
  ) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    if (Date.now() < this.bannedUntil) throw new GmgnError('RATE_LIMIT_BANNED', 'cooling down');
    const qs = new URLSearchParams({ ...params, timestamp: String(Math.floor(Date.now() / 1000)), client_id: randomUUID() });
    try {
      const r = await this.http.json<{ code: number; data?: T; error?: string; message?: string; reset_at?: number }>(
        `${GMGN_HOST}${path}?${qs}`,
        { headers: { 'X-APIKEY': this.apiKey }, label: `gmgn:${path}`, retries: 0 },
      );
      if (r.code !== 0) throw new GmgnError(r.error ?? String(r.code), r.message ?? '');
      return r.data as T;
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        let resetAt = Date.now() + 60_000;
        try {
          const body = JSON.parse(err.body);
          if (body.reset_at) resetAt = body.reset_at * 1000;
        } catch {
          /* keep default */
        }
        this.bannedUntil = resetAt;
        throw new GmgnError('RATE_LIMITED', `until ${new Date(resetAt).toISOString()}`);
      }
      throw err;
    }
  }

  info(mint: string) {
    return this.get<Obj>('/v1/token/info', { chain: 'sol', address: mint });
  }
  security(mint: string) {
    return this.get<Obj>('/v1/token/security', { chain: 'sol', address: mint });
  }
  createdTokens(wallet: string) {
    return this.get<Obj>('/v1/user/created_tokens', { chain: 'sol', wallet_address: wallet });
  }

  /** info + security (2 weight). Either may fail independently. */
  async facts(mint: string): Promise<GmgnFacts> {
    const [info, sec] = await Promise.allSettled([this.info(mint), this.security(mint)]);
    if (info.status === 'rejected' && sec.status === 'rejected') throw info.reason;
    return mapGmgn(mint, info.status === 'fulfilled' ? info.value : null, sec.status === 'fulfilled' ? sec.value : null);
  }

  /** Dev history: launches and graduation rate (`open_count` = reached an open market). */
  async devHistory(wallet: string): Promise<{ launches: number; migrated: number; gradRate: number | null }> {
    const d = await this.createdTokens(wallet);
    const inner = num(d?.inner_count) ?? 0;
    const open = num(d?.open_count) ?? 0;
    const rows = Array.isArray(d?.tokens) ? d.tokens.length : 0;
    const launches = Math.max(inner + open, rows);
    return { launches, migrated: open, gradRate: launches ? open / launches : null };
  }
}
