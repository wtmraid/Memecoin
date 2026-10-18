# Memecoin scanner (Solana)

Finds new and trending Solana memecoins, rejects rugs, scores the rest, and sends
**Telegram alerts with an entry/exit plan**. It then follows every alert and sends
**sell recommendations** (take-profit, stop, emergency exits) as replies to the alert.
The only link in alerts is the token's **GMGN page**.

> **Read this first.** No bot can predict memecoins. Most pump.fun launches go to zero,
> and a good filter still loses on many trades. This bot is built to (1) avoid the
> mechanical rug patterns — bundles, insiders, dev farms, honeypots, mint/freeze tricks —
> and (2) cut losers fast while letting winners run. Every alert is a **rule-based
> signal, not financial advice**. Paper-trade it (it does this automatically) and check
> `npm run report` before you put real money behind it.

- Plan & architecture: [docs/PLAN.md](docs/PLAN.md) · API research: [docs/RESEARCH.md](docs/RESEARCH.md)

## What an alert looks like

_Illustrative example (made-up token and numbers):_

```
🎯 SNIPE · Score 78/100 · data 92%
$REAL (Real Coin)
7xKX…pump                                  ← full CA, tap to copy
⏱ 4m · 📈 Curve 41% · 22.6 SOL · MC $18.4K · 👥 96

Core Metrics                               ← same tiles as GMGN's Data tab
Taxes 1.25% ✅  ·  Top 10 18.2% ✅
Bundler 4% ✅  ·  Phishing 1.1% ✅
Insiders 0% ✅  ·  Sniper 2.4% ✅
Dev holdings 1.9% ✅  ·  Dev Migrated 6
Rug 2% ✅  ·  Dev sold/closed
✅ NoMint  ✅ NoFreeze  ✅ LP  ✅ Top10  ✅ Sellable

Why now — 96 unique buyers in 4m · curve 41% · 2m buy/sell 3.1
• buyerVelocity 100/100 — 71 unique buyers / 5m
• buyPressure 88/100 — 72% buys (5m)  …

Plan (rule, not advice)
• Entry: now, up to MC $21.2K (+15%). Above that, don't chase; wait for a pullback.
• Stop-loss: −30% → MC $12.9K
• TP1: 2x (MC $36.8K) → sell 50% (gets your initial back)
• TP2: 3x (MC $55.2K) → sell 25%
• Rest: trailing stop 30% below the peak after TP1
• Time stop: not +20% after 30 min → exit
• Emergency exit: dev sells ≥20% · bundle wallets dump ≥30% · liquidity −30% · sell wall
🔗 Open on GMGN   [📈 Open on GMGN] button → https://gmgn.ai/sol/token/<CA>
```

Follow-ups arrive as **replies** to that alert:
`💰 TAKE PROFIT 50% of position · TP1 hit: 2.04x` → `🚨 SELL NOW 50% · dev sold 100% of their bag` → `🏁 CLOSED · paper P&L +41.3%`.

The token from your screenshot (Bundler **31.75%**) would be **rejected**. More than
20% of supply bought by bot-bundled wallets at launch is the classic setup for a
coordinated dump. Every other tile on it was fine, and that one is enough.

## How it decides

1. **Discovery.** pump.fun launches stream in live from Helius WebSockets. New pools on PumpSwap,
   Raydium and Meteora, DexScreener and GeckoTerminal trending lists, Reddit, Telegram channels
   (including caller/volume-signal channels you follow) and your smart wallets are added on top.
2. **Cheap gates, every 5 s, free.** For each token, metrics are computed from the trades the bot
   has seen: bundle share (buys in the creation slot), snipers, dev holdings, top 10, wash churn,
   curve SOL and minimum age.
3. **Earliest entry.** A token qualifies as soon as it shows real, distributed demand:
   - **SNIPE** (under 15 min): at least 25 unique buyers, curve between 12% and 85%, and
     buyers outnumbering sellers over the last 2 min. It deliberately skips the first ~60 s,
     when bundles, snipers and dev dumps happen and safety data means nothing yet.
   - **SCALP** (over 15 min): 5-minute volume at least 2.5× the hourly average, price up 3–40%
     (so it doesn't chase a vertical candle), buyers in control.
4. **Deep safety checks, only for candidates:**
   - GMGN Core Metrics.
   - On-chain mint account: mint and freeze authority, dangerous Token-2022 extensions.
   - RugCheck.
   - The dev's launch history (rug ratio, serial farms, launches in the last 24h).
   - Socials: real account, not a borrowed tweet, not recycled from another token.
   - A Jupiter **sell test**, run last: buy, then sell the same amount back, to catch
     honeypots and hidden taxes.
5. **Score 0–100** from buy pressure, unique-buyer velocity, volume breakout, holder growth,
   liquidity growth, smart money and KOLs, social mentions (rug/scam chatter penalised),
   holder distribution and dev quality. It alerts only at 65 or above (SCALP: 70) with at
   least 50% of inputs available.
6. **Follow-up.** Every alert is paper-traded with slippage, fees, priority fee, Jito tip and
   reaction latency. Exit rules fire as Telegram replies. Outcomes at +1m, +5m, +15m, +1h and
   +24h, plus max gain, max drawdown and rug status, go into SQLite for `npm run report`.

Every threshold, weight and exit level is in [`config/default.json`](config/default.json).

## Setup

```bash
node -v                 # 20+ (22 recommended)
npm install
cp .env.example .env    # fill in the keys below
npm test                # unit tests (191)
npm run smoke           # live check of every API + sends a test message to Telegram
npm start               # run the scanner 24/7
```

| Key | Where | Needed for |
|---|---|---|
| `HELIUS_API_KEY` | dashboard.helius.dev (free plan works) | live pump.fun stream, mint checks |
| `GMGN_API_KEY` | gmgn.ai/ai | the GMGN Core Metrics (bundler, insiders, phishing, rug ratio, dev migrated). Without it the bot falls back to its own on-chain estimates, and insiders, phishing and rug ratio show as unknown |
| `JUPITER_API_KEY` | developers.jup.ag | sell test at 1 rps (keyless works at 0.5 rps) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID` | @BotFather; add the bot to your chat | alerts |

**GMGN note:** its API is IPv4-only. If you get 401/403 with a valid key on a VPS, disable IPv6.

### Using it from Telegram
- Alerts and sell updates arrive in `TELEGRAM_ALERT_CHAT_ID`.
- **Paste any CA** (or `/scan <CA>`) in that chat to get a full scan with the same layout and a
  verdict: `✅ ENTRY`, `⏳ SAFE SO FAR, NO ENTRY YET`, `⚠️ WEAK MOMENTUM` or `❌ REJECT` with reasons.
- `/open` lists the signals being tracked.
- Following a signal channel (like a pump.fun volume-signal group)? Put its username in
  `TELEGRAM_CHANNELS` and `TELEGRAM_KOL_CHANNELS` with `ENABLE_TELEGRAM=true`. Its calls then count
  toward the social score and pull those tokens into the scanner.
- CLI equivalent: `npm run scan -- <CA>`.

## Is it working? (`npm run report`)

_Example layout (illustrative numbers):_
```
group                          n  win   avgWin  avgLoss  expect.   maxDD   ≥2x  ≥3x  rug
ALL                           84  38%   +71.2%   -24.9%    +11.6%  -148.0%  31%  17%   6%
mode=SNIPE score=80-89        21  48%  …
```
Positive **expectancy** (average P&L per trade after all costs) is what matters, not win
rate. The stats are noise until you have at least 50 finished signals. If a score bucket or mode is
negative, raise its threshold in `config/default.json`.

## API costs (as of 2026-10, see docs/RESEARCH.md)

| Service | Needed? | Cost |
|---|---|---|
| Helius | **yes** | Free: 1M credits/mo. Developer $49/mo. The pump.fun stream is the main credit user; watch the dashboard on day 1 |
| GMGN OpenAPI | strongly recommended | Free plan (~5 req/s); paid plans raise limits |
| Jupiter | yes (sell test) | Free key 1 rps |
| DexScreener, GeckoTerminal, RugCheck | yes | Free, no key |
| Telegram Bot | yes | Free |
| Reddit / Telegram user client | optional | Free |
| X API | optional | $0.005 per post read: KOL list only (see RESEARCH) |
| VPS | 24/7 | ~$5–10/mo, IPv4 |

## Running 24/7

```bash
docker compose up -d --build
docker compose logs -f scanner     # "health" line every minute: tracked tokens, signals, SOL price
```

## Phases

| Phase | Status |
|---|---|
| 1. Ingestion (on-chain, market, social, smart money) | ✅ |
| 2. Safety filters (20 checks, each unit-tested) | ✅ |
| 3. Scoring, SNIPE/SCALP, Telegram/Discord alerts, sell follow-ups | ✅ (web dashboard pending) |
| 4. Paper trading, outcome logging, `npm run report` | ✅. The threshold tuner script is pending (it needs logged data first) |
| 5. Live execution | **not built**. Only on explicit request, dry-run by default |

## Known limitations
- Fixtures were hand-built from documented API shapes (the build sandbox couldn't reach
  the APIs). `npm run smoke` checks the real ones; if it fails, fix that first.
- The on-chain bundler, sniper and dev numbers only exist for launches the bot saw live. For older
  tokens it relies on GMGN.
- After migration, prices come from DexScreener (about 5 s polling for open signals), so exits on
  migrated tokens react more slowly than on the curve.
- Unconfirmed program IDs and log markers (Meteora DBC/DAMM v1, LaunchLab) are flagged in
  `src/ingest/onchain/programs.ts`.
