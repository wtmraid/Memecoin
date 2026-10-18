import type { HttpClient } from '../core/http.js';

export interface RugcheckSummary {
  /** 0–100, higher = riskier. */
  scoreNormalised: number | null;
  /** Risk names RugCheck marks as `danger`. */
  dangers: string[];
  warnings: string[];
  lpLockedPct: number | null;
}

interface Raw {
  score?: number;
  score_normalised?: number;
  lpLockedPct?: number;
  risks?: { name?: string; level?: string; description?: string }[];
}

/** Pure mapping. Risk names come from a third party — treated as plain text only. */
export function mapRugcheck(r: Raw): RugcheckSummary {
  const risks = Array.isArray(r.risks) ? r.risks : [];
  const clean = (s?: string) => (s ?? '').replace(/[<>&]/g, '').slice(0, 80);
  return {
    scoreNormalised: typeof r.score_normalised === 'number' ? r.score_normalised : null,
    dangers: risks.filter((x) => x.level === 'danger').map((x) => clean(x.name)),
    warnings: risks.filter((x) => x.level === 'warn').map((x) => clean(x.name)),
    lpLockedPct: typeof r.lpLockedPct === 'number' ? r.lpLockedPct : null,
  };
}

export class RugcheckClient {
  constructor(private http: HttpClient) {}
  async summary(mint: string): Promise<RugcheckSummary> {
    return mapRugcheck(
      await this.http.json<Raw>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { label: 'rugcheck:summary', retries: 1 }),
    );
  }
}
