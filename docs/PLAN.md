# Build plan

Each phase ships with tests and must run (`npm test`, `npm run typecheck`) before
the next one starts. Live trading code does not exist until Phase 5 is requested.

## Architecture

```
            ┌──────────── ingest/ ─────────────┐
 Helius WS ─┤ onchain: pumpfun, pools, wallets │
 DexScreener┤ market: dexscreener, gecko, bird │──► EventBus ──► TokenRegistry ──► SQLite
 Reddit/TG/X┤ social: mentions + velocity      │        │             │
            └──────────────────────────────────┘        │             ▼
                                         filters/ (P2) ◄┘   scoring/ (P3) ──► alerts/ (P3)
                                                                   │
                                                     backtest/ paper trading (P4)
                                                                   │
                                                     execution/ (P5, opt-in, dry-run default)
```

- **EventBus** — typed events (`token.created`, `pool.created`, `pumpfun.trade`,
  `pumpfun.complete`, `pumpfun.migrated`, `market.snapshot`, `social.mention`,
  `wallet.trade`). Every module talks only through it, so sources can be swapped
  (WS → gRPC) without touching consumers.
- **TokenRegistry** — tracked-token state, batches DexScreener refreshes
  (30 mints/call), schedules bonding-curve reads, expires stale tokens.
- **Storage** — SQLite (better-sqlite3, WAL) for a single VPS. Schema is plain SQL
  so moving to Postgres later is mechanical.
- **Config** — `.env` for secrets, `config/default.json` for every threshold and
  weight (validated with zod). Phase 4's tuner writes a new config file, never
  edits code.

## Phases
1. **Ingestion** (this PR): resilient WS client, pump.fun event decoder,
   pool-creation detector for PumpSwap / Raydium AMM v4, CPMM, CLMM, LaunchLab /
   Meteora DLMM, DAMM v1/v2, DBC; bonding-curve reader; DexScreener / GeckoTerminal /
   Birdeye clients; holders via RPC + DAS; Reddit, Telegram, X (budgeted) mention
   ingestion with CA/ticker extraction and velocity; smart-wallet buy detection;
   SQLite persistence; `npm run ingest`, `npm run smoke`.
2. **Safety filters**: one pure function per filter `(TokenFacts, cfg) → {pass, reason, value}`,
   cheap → expensive order, Jupiter sell sim last. Every filter unit-tested.
3. **Scoring + alerts**: weighted features normalised 0–1 → 0–100, SNIPE/SCALP
   modes, Telegram + Discord with rate-limited queues, Next.js dashboard reading SQLite.
4. **Paper trading + evaluation**: fill model (slippage from curve/AMM math +
   priority fee + Jito tip + latency), outcome tracker (+1m…+24h, MDD, rug flag),
   reports per mode/score bucket, walk-forward tuner.
5. **Live execution** — only on request.

## Status (2026-10-18)
Phases 1–3 built, Phase 4's paper trading / outcome logging / report built (tuner pending
until there is logged data). Alerts reference GMGN only, per the user's preference.
