# API research — as of 2026-10-16

How this was gathered: web search against vendor docs, vendor pricing pages and
reputable secondary sources. Direct fetches of the doc sites and the APIs
themselves were **blocked by the build sandbox's network policy**, so nothing
below was smoke-tested against a live endpoint from the build machine. Every
claim marked **(verify)** should be checked with one live call before you rely
on it. `npm run smoke` (Phase 1) does exactly that from your own machine/VPS.

## Summary table

| Source | Used for | Auth | Free tier | Paid entry | Limits we design for |
|---|---|---|---|---|---|
| Helius RPC + WebSockets | new pools/tokens, wallet watch, holders, bonding curve | API key in URL | Free: 1M credits/mo, ~10 RPC rps, 2 DAS rps, 1 sendTx/s, 5 gPA/s | Developer $49/mo (10M credits) | Standard `logsSubscribe` on **all** plans; WS billed 2 credits / 0.1 MB |
| Helius Enhanced WS (`transactionSubscribe`) | richer stream | key | no | Mainnet needs **Business $499/mo** | optional, not required |
| Helius LaserStream (Yellowstone gRPC) | lowest-latency stream | key | no | Mainnet needs **Business $499/mo** | optional, adapter slot only |
| DexScreener | price, liquidity, volume, buys/sells, socials, boosts | none | free | — | ~300 req/min pairs/tokens, ~60 req/min profiles/boosts **(verify)** ; up to 30 addresses per `tokens/v1` call |
| GeckoTerminal (keyless) | new/trending pool discovery, OHLCV | none | free | CoinGecko paid plans | **~10 calls/min** shared per IP, data ~60 s stale, 20 pools/page |
| Birdeye | holder count, overview, security (optional) | `X-API-KEY` + `x-chain` | Standard $0: 30k CU, 1 rps | Starter $99/mo: 3M CU, 15 rps | optional enrichment |
| Jupiter Swap API (Phase 2 sell sim) | honeypot / sell quote | `x-api-key` (Developer Platform) | Free 1 rps with key; keyless 0.5 rps | paid tiers on developers.jup.ag/pricing | `https://api.jup.ag/swap/v1/quote`. **lite-api.jup.ag is being retired** (grace period ended 2026-06-30) |
| RugCheck | risk score input (Phase 2) | read endpoints reportedly keyless; key via dashboard for higher use **(verify)** | free | — | `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary` (+ `/report`) |
| X (Twitter) API | $TICKER / CA mention velocity, KOL watchlist | Bearer | **No free tier for new devs since 2026-02-06** | Pay-per-use: **$0.005 per post read**, cap 2M reads/mo; legacy Basic/Pro migrated to PPU in 2026 | expensive at scale (see below) |
| twitterapi.io (3rd party) | cheaper X read alternative | `X-API-Key` | credits trial | ~$0.15 / 1k tweets, min $0.00015/request | unofficial; ToS risk is yours |
| Telegram (MTProto user client, GramJS) | public channel/group mentions | api_id/api_hash from my.telegram.org + session | free | — | read-only; flood-wait handling; use your own api_id |
| Telegram Bot API | alerts out (Phase 3) | bot token | free | — | ~30 msg/s global, ~20 msg/min per group **(verify)** |
| Discord webhooks | alerts out (Phase 3) | webhook URL | free | — | ~5 req / 2 s per webhook, honour `retry_after` on 429 |
| Reddit Data API | r/solana, r/CryptoMoonShots, r/SolanaMemeCoins | OAuth2 (script app) + unique User-Agent | 100 QPM per OAuth client (10-min avg), **non-commercial only** | commercial by agreement | new apps reportedly need manual approval (2–4 weeks) **(verify)** |
| Jito block engine (Phase 4/5) | tips, bundles | none for basic | — | — | min tip 1,000 lamports (Jito/Alchemy) vs 5,000 (Helius docs) — conflicting; bundles ≤5 tx |

## Details and design decisions

### On-chain streaming: Helius standard WebSockets
- Helius plans changed **2026-04-07**: Free $0 (1M credits), Developer $49 (10M),
  Business $499 (100M), Professional $999 (200M).
- Standard Solana WS methods (`logsSubscribe`, `accountSubscribe`, …) work on every plan.
  `transactionSubscribe` (Enhanced WS) and LaserStream gRPC on **mainnet** need Business+.
- **Decision:** Phase 1 uses standard `logsSubscribe` with `mentions: [programId]`,
  one subscription per program. Everything we need for pump.fun is in the logs
  (Anchor `Program data:` events), so no extra RPC calls per pump.fun event. For
  AMM pool creation we detect the instruction in logs, then call `getTransaction`
  once to read the mints. A gRPC adapter can be swapped in later behind the same
  `LogSource` interface without touching downstream code.
- Cost note: WS traffic is billed at 2 credits per 0.1 MB. Subscribing to *all*
  pump.fun logs is high-volume (every trade). The pump.fun stream is the biggest
  credit consumer; `PUMPFUN_TRADES=false` drops trade events at the source if you
  only want creations/migrations. Watch usage in the Helius dashboard during the
  first day.
- Free plan RPC limits (Helius rate-limit doc): 10 RPC rps, 2 DAS rps, 5 gPA/s,
  1 sendTransaction/s. Our HTTP layer has a per-host token bucket set below these.

### Program IDs (mainnet)
| Program | ID | Source |
|---|---|---|
| pump.fun bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | pump-public-docs, Solana Tracker |
| PumpSwap AMM | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | pump-public-docs |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | docs.raydium.io (verified 2026-04). UI no longer creates v4 pools by default; still accepts `initialize2` |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | docs.raydium.io |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | docs.raydium.io |
| Raydium LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | docs.raydium.io |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | Meteora program table |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | Meteora program table |
| Meteora DAMM v1 | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | Meteora program table **(verify)** |
| Meteora Dynamic Bonding Curve | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | MeteoraAg GitHub **(verify — not confirmed by search)** |

All IDs live in `src/ingest/onchain/programs.ts` and can be overridden in config.

### pump.fun mechanics
- Anchor events in logs: `CreateEvent` (on `create`/`create_v2`), `TradeEvent`,
  `CompleteEvent` (curve finished), `CompletePumpAmmMigrationEvent` (moved to PumpSwap).
  Discriminator = first 8 bytes of `sha256("event:<Name>")`.
- **Layouts grow over time** (fields appended — e.g. `is_holder_reward` added to
  CreateEvent in the latest IDL, SDK `@pump-fun/pump-sdk` 4.1.0). Our decoder reads the
  documented prefix and ignores trailing bytes, so appended fields don't break it.
  Pin and re-check against `github.com/pump-fun/pump-public-docs` when pump.fun upgrades.
- Bonding-curve account: 8-byte discriminator, then u64 virtualTokenReserves,
  virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, bool
  complete, pubkey creator (appended fields after). PDA seeds `["bonding-curve", mint]`.
- Graduation ≈ 85 SOL raised / all ~793.1M curve tokens sold. We compute progress
  from tokens sold: `1 − realTokenReserves / 793_100_000e6` (independent of SOL price),
  and report real SOL raised too. Graduates migrate to **PumpSwap** (no 6 SOL Raydium
  fee any more). Note pump.fun's "synthetic migration" rule in the latest IDL: the final
  buy can exceed remaining curve supply — progress is clamped to [0, 1].
- pump.fun's own frontend API (`frontend-api-v3`) needs a JWT for most routes —
  not used. PumpPortal (3rd-party WS) is a possible fallback, not required.

### DexScreener
- Base `https://api.dexscreener.com`, no key.
- `GET /tokens/v1/solana/{addr1,addr2,…}` — up to 30 addresses, returns pair objects.
- `GET /token-profiles/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1`
  for trending discovery (lower limit, ~60/min).
- Pair fields we use: `pairAddress`, `dexId`, `baseToken`, `quoteToken`, `priceUsd`
  (string), `priceNative` (string), `txns.{m5,h1,h6,h24}.{buys,sells}`,
  `volume.{m5,h1,h6,h24}`, `priceChange.{m5,h1,h6,h24}`, `liquidity.{usd,base,quote}`,
  `fdv`, `marketCap`, `pairCreatedAt` (ms), optional `info.{websites,socials}` (only
  if the profile is claimed). Rate limits come from community wrappers, not official
  docs → we default to 250/min and back off on 429.

### GeckoTerminal
- Keyless base `https://api.geckoterminal.com/api/v2` (keyed plans use a different
  `/onchain` base on CoinGecko Pro). ~10 calls/min/IP, data cached ~60 s.
- `GET /networks/solana/new_pools?include=base_token` and `/networks/solana/trending_pools`.
  Used only as a slow discovery cross-check (1 call / 30 s by default).

### Birdeye (optional)
- Standard (free) plan = 1 rps and "limited data access"; Starter $99/mo = 15 rps.
- Header `X-API-KEY`, `x-chain: solana`. We only call it if `BIRDEYE_API_KEY` is set,
  for holder count fallback. Holder count otherwise comes from Helius DAS
  `getTokenAccounts` (paginated, capped) — cheaper and keyless beyond Helius.

### Jupiter (Phase 2 honeypot check)
- New Developer Platform (April 2026). Keys from developers.jup.ag; header `x-api-key`.
- Quote: `GET https://api.jup.ag/swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=`.
- Free plan 1 rps; keyless 0.5 rps. **Do not build on lite-api.jup.ag** (being retired).
  1 rps means the sell simulation is the bottleneck of the safety pipeline → it runs
  last, only on tokens that passed every cheaper check.

### RugCheck (Phase 2)
- `GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary` → `score`,
  `score_normalised` (0–100, higher = riskier), `risks[]`, LP lock %.
  Full `/report` adds holders, markets, creator, insiders. Swagger at
  api.rugcheck.xyz/swagger. Treated as **one input**, never sole authority, and its
  text fields are treated as untrusted (never rendered as HTML / passed to an LLM).

### X / Twitter — cost reality and alternatives
- Since 2026-02-06 new developers get **pay-per-use only**: $0.005 per post read,
  $0.01 per post created, max 2M reads/month. Legacy Basic ($200) and Pro were
  migrated to pay-per-use during 2026.
- Example: polling recent search for 50 tracked tokens every 2 minutes, ~10 new
  posts each → 50 × 720 × 10 = 360k reads/day ≈ **$1,800/day**. Not viable.
  Polling a KOL watchlist of 30 accounts (≈ 300 posts/day total) ≈ $1.50/day — viable.
- **Decision:** X is disabled by default. Two providers behind one interface:
  1. `official` — KOL watchlist only (cheap), plus on-demand search for tokens that
     already scored high elsewhere (bounded by `X_MAX_READS_PER_DAY`).
  2. `twitterapi_io` — ~30× cheaper per tweet; third-party, unofficial; you accept
     its ToS risk.
  A hard daily read budget is enforced in code for both.
- Other alternatives documented in README: Telegram + DexScreener boosts as a proxy
  for hype; manual KOL lists.

### Telegram (input)
- MTProto user client via GramJS (`telegram` npm package). Free.
- Use **your own** api_id/api_hash (shared/public ones trigger `API_ID_PUBLISHED_FLOOD`).
  Read-only usage (listening for new messages in channels you've joined) is low-risk;
  we never send from the user account. Use an aged account, not a fresh one.
  Handle `FLOOD_WAIT_x` by sleeping x seconds (GramJS does this up to `floodSleepThreshold`).

### Reddit
- OAuth2 is mandatory; unauthenticated traffic is blocked. Free tier: 100 QPM per
  client, **non-commercial use only**. New apps may require manual approval.
- Script-type app, `client_credentials` grant (read-only public data), descriptive
  User-Agent `platform:app-id:version (by /u/name)`.
- 3 subreddits × `/new` every 60 s = 3 QPM — far under the limit.

### Smart money
- `logsSubscribe` accepts **one** address in `mentions`, so one subscription per wallet.
  Fine for a watchlist of tens of wallets; for hundreds, use LaserStream (Business plan)
  or Helius webhooks. On each log we fetch the tx and diff the wallet's pre/post token
  and SOL balances to classify buy/sell — DEX-agnostic.

### Alerts out (Phase 3) and Jito (Phase 4/5)
- Discord webhooks ~5 requests/2 s per webhook; queue + respect `retry_after`.
- Telegram Bot API: queue, ≤1 msg/s per chat.
- Jito: tip = SOL transfer to one of 8 tip accounts (`getTipAccounts`), random pick;
  min tip quoted as 1,000 lamports (Alchemy) vs 5,000 (Helius). Paper-trading
  model in Phase 4 will use a configurable tip that defaults to the observed
  tip-floor percentile, not the minimum.

## Sources
- Helius plans: https://www.helius.dev/docs/billing/plans · rate limits: https://www.helius.dev/docs/billing/rate-limits · logsSubscribe: https://www.helius.dev/docs/api-reference/rpc/websocket/logssubscribe.md · transactionSubscribe: https://www.helius.dev/docs/rpc/websocket/transaction-subscribe
- DexScreener (community docs): https://github.com/opensvm/dexscreener-mcp-server · https://claudeskills.info/skills/agiprolabs/claude-trading-skills/dexscreener-api/
- GeckoTerminal: https://docs.coingecko.com/docs/keyless-public-api.md · https://apiguide.geckoterminal.com/changelogs
- Birdeye: https://docs.birdeye.so/docs/pricing · https://docs.birdeye.so/docs/rate-limiting
- Jupiter: https://developers.jup.ag/docs/portal/migration · https://developers.jup.ag/pricing · https://developers.jup.ag/docs/portal/setup
- RugCheck: https://termo.ai/skills/rugcheck · https://apidog.com/id/blog/rugcheck-api/
- X API: https://www.postproxy.dev/blog/x-api-pricing-2026/ · https://gigazine.net/gsc_news/en/20260209-x-api-pay-per-use · https://opentweet.io/x-api-pricing
- twitterapi.io: https://www.getxapi.com/blogs/cheapest-twitter-api-2026-8-providers-ranked-by-real-per-1000-tweet-cost
- Telegram: https://www.unipile.com/is-the-telegram-api-free/
- Reddit: https://www.socialcrawl.dev/blog/reddit-api-key-limits-alternatives-2026 · https://www.mallary.ai/blog/reddit-api
- pump.fun: https://github.com/pump-fun/pump-public-docs · https://deepwiki.com/pump-fun/pump-public-docs/10.1-pump-program-idl · https://docs.solanatracker.io/guides/pumpfun-program · https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/pump-fun-to-pump-swap/ · https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives
- Raydium: https://docs.raydium.io/reference/program-addresses · https://docs.raydium.io/products/amm-v4/code-demos
- Meteora: https://skills.sh/sendaifun/skills/meteora · https://github.com/MeteoraAg
- Jito: https://www.alchemy.com/docs/chains/solana/solana-jito-bundles-and-transactions · https://docs.helius.dev/docs/sending-transactions/send-bundle.md
- Discord: https://space-node.net/blog/discord-webhook-rate-limits-official-2026
