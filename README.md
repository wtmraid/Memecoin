# Memecoin scanner (Solana)

A scanner and signal bot for Solana memecoins. It finds new and trending tokens,
filters out rugs, scores what's left and sends alerts. It learns from logged outcomes.

> **Status: Phase 1 (data ingestion) is done.** It has no alerts, no scoring and no
> trading. Live trading is not built and will only be built on explicit request
> (Phase 5). Nothing here is financial advice.

- Plan & architecture: [docs/PLAN.md](docs/PLAN.md)
- API research (endpoints, limits, pricing as of 2026-10-16): [docs/RESEARCH.md](docs/RESEARCH.md)

## What Phase 1 ingests

| Data | Source | How |
|---|---|---|
| New pump.fun tokens, every curve trade, curve complete, PumpSwap migration | Helius WS `logsSubscribe` on the pump.fun program | Anchor events decoded straight from logs, so no extra RPC calls |
| New pools: PumpSwap, Raydium CPMM / LaunchLab, Meteora DAMM v2 / DBC (opt-in: Raydium AMM v4, CLMM, Meteora DLMM, DAMM v1) | `logsSubscribe` per program, then one `getTransaction` | Pair found from vault balances, which works on any DEX |
| Bonding-curve progress | Trade-event reserves (free); `getAccountInfo` fallback | `progress = tokens sold / 793.1M` |
| Price, liquidity, volume, buys/sells, socials | DexScreener `tokens/v1` (30 mints per call) | Refreshed for every tracked token |
| New/trending pools, unique buyers/sellers | GeckoTerminal keyless | Slow discovery poll |
| Top holders (with owners), holder count | RPC `getTokenLargestAccounts`, Helius DAS `getTokenAccounts` | Rate-limited, newest tokens first |
| Mentions of CAs and $TICKERs, plus velocity | Reddit (official API), Telegram (GramJS user client), X (budgeted) | Per-token 5m/1h counts, unique authors, KOL hits, acceleration |
| Smart-money buys | `logsSubscribe` per wallet, then balance diff | Works on any DEX, ignores plain transfers |

Everything goes to SQLite (`data/scanner.db`): tables `tokens`, `pools`, `pump_trades`,
`curve_snapshots`, `market_snapshots`, `holder_snapshots`, `mentions`, `wallet_trades`.

## Setup

```bash
node -v            # 20+ (22 recommended)
npm install
cp .env.example .env   # add HELIUS_API_KEY at minimum
npm test               # 76 unit tests
npm run smoke          # live check of every configured API: run this first
npm run ingest         # start Phase 1
```

Optional sources:
- **Reddit:** create a "script" app at reddit.com/prefs/apps, fill the `REDDIT_*` vars and set `ENABLE_REDDIT=true`.
  The free tier is non-commercial only, and new apps may need manual approval.
- **Telegram:** get your own api_id and hash at my.telegram.org, run `npm run telegram:login`, paste the
  session into `.env`, list the channels in `TELEGRAM_CHANNELS` and set `ENABLE_TELEGRAM=true`. Use an
  aged account. The client only reads and never sends.
- **X:** set `X_PROVIDER=official` (or `twitterapi_io`) with a key, and list `KOL_X_HANDLES`.
  `social.xMaxReadsPerDay` in `config/default.json` is a hard cap enforced in code.
- **Smart wallets:** `SMART_WALLETS=addr1,addr2` and `ENABLE_SMART_WALLETS=true`.

All tunables (refresh rates, budgets, venues, rate limits) are in `config/default.json`.
Secrets are only ever read from `.env`.

## API costs (as of 2026-10-16, see docs/RESEARCH.md)

| Service | Needed? | Cost |
|---|---|---|
| Helius | **yes** (or another RPC) | Free: 1M credits/mo, ~10 RPC rps. Developer $49/mo (10M). LaserStream/Enhanced WS on mainnet need Business ($499/mo) and are **not** required. |
| DexScreener | yes | Free, no key (~300 req/min, ~60/min on profile/boost endpoints) |
| GeckoTerminal | optional | Free, keyless ~10 calls/min |
| Birdeye | optional | Free 1 rps (30k CU), Starter $99/mo |
| Jupiter (Phase 2 sell sim) | Phase 2 | Free key: 1 rps. Keyless: 0.5 rps. lite-api is being retired |
| RugCheck (Phase 2) | Phase 2 | Free |
| Reddit | optional | Free (non-commercial) |
| Telegram | optional | Free |
| X official | optional | Pay-per-use **$0.005 per post read**. Watching a 30-KOL list is about $1–2/day; broad token search is about $1k+/day, so it isn't used |
| twitterapi.io | optional alternative | About $0.15 per 1k tweets (third-party, unofficial) |
| VPS | for 24/7 | About $5–10/mo (2 vCPU, 2 GB RAM is enough for Phase 1–3) |

**Helius credit budget:** WS traffic costs 2 credits per 0.1 MB. The pump.fun log stream
(every trade) is the main cost. Check the Helius dashboard during the first day. If you
burn through the free 1M credits, set `ENABLE_PUMPFUN_TRADES=false` or move to Developer.

## Running 24/7 (docker-compose)

```bash
cp .env.example .env && $EDITOR .env
docker compose up -d --build
docker compose logs -f scanner      # a "health" line prints every minute
```

The SQLite DB lives in the `scanner-data` volume. `config/` is mounted read-only,
so you can retune without rebuilding (`docker compose restart scanner`).

## Running each phase

| Phase | Command | Status |
|---|---|---|
| 1. Ingestion | `npm run ingest` | ✅ built and tested |
| 2. Safety filters | — | next |
| 3. Scoring, alerts, dashboard | — | pending |
| 4. Paper trading and evaluation | — | pending |
| 5. Live execution | — | only on request |

## Repo layout

```
src/
  core/        event bus, rate-limited HTTP, logger, types
  config/      env + JSON settings (zod-validated)
  ingest/
    onchain/   WS client, RPC, pump.fun decoder, pool detector, bonding curve, holders
    market/    DexScreener, GeckoTerminal, Birdeye
    social/    CA/ticker extraction, velocity, Reddit, Telegram, X
    smartmoney/ wallet watcher
  pipeline/    token registry (refresh scheduling) + recorder (SQLite batching)
  storage/     SQLite schema
  filters/ scoring/ alerts/ backtest/ execution/   ← later phases
scripts/       smoke test, telegram login
test/          unit tests (vitest)
```

## Known limitations / verify on first run
- Response fixtures in `test/fixtures` were built by hand from documented shapes, because the build
  sandbox couldn't reach the APIs. `npm run smoke` checks the real shapes. If it fails,
  that's the first thing to fix.
- pump.fun appends fields to its event layouts over time. The decoder reads the stable
  prefix and ignores the rest. If smoke reports "0 decoded events", check
  `github.com/pump-fun/pump-public-docs`.
- Not confirmed by research: the Meteora DBC and DAMM v1 program IDs, and the exact
  instruction log names for LaunchLab/DBC (see `src/ingest/onchain/programs.ts`).
