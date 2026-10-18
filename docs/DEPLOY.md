# Run the bot 24/7 (from your phone, ~15 minutes)

The bot runs on a small cloud server and talks to you in **Telegram**. You don't need a
computer for any of these steps.

## 1. Create your Telegram bot (2 min)
1. In Telegram, open **@BotFather** → send `/newbot` → pick a name and a username.
2. Copy the **token** it gives you (looks like `123456:ABC-...`). This is `TELEGRAM_BOT_TOKEN`.

## 2. Get the API keys (5 min)
| Variable | Where | Notes |
|---|---|---|
| `HELIUS_API_KEY` | dashboard.helius.dev → sign up → API Keys | Free plan is enough to start |
| `GMGN_API_KEY` | gmgn.ai/ai → generate API key | Gives the exact GMGN "Core Metrics". Strongly recommended |
| `JUPITER_API_KEY` | developers.jup.ag → sign up → API key | For the honeypot / sell test |

## 3. Deploy on Railway (5 min, ~$5/month)
1. Go to **railway.com** → *Login with GitHub*.
2. **New Project → Deploy from GitHub repo → `wtmraid/memecoin`**.
   If it asks for a branch, choose the branch that has this file (currently `phase1-ingestion`).
   Railway finds the `Dockerfile` and builds it automatically.
3. Open the service → **Variables** → add:
   ```
   HELIUS_API_KEY=...
   GMGN_API_KEY=...
   JUPITER_API_KEY=...
   TELEGRAM_BOT_TOKEN=...
   ```
4. Add storage so signal history survives restarts: in the project canvas, **+ New → Volume**
   (or right-click the service → *Attach volume*), mount path **`/app/data`**.
5. Deploy. In **Deployments → View logs** you should see `starting scanner` and,
   after a minute, a `health` line.

## 4. Connect it to your chat (1 min)
1. Open your new bot in Telegram and send it **hi**.
2. It answers: `Your chat id is 123456789`.
3. In Railway → Variables, add `TELEGRAM_ALERT_CHAT_ID=123456789`. Railway restarts the bot.
4. You get **✅ Scanner online**. Done.

## 5. Checking on it
- `/status` → is everything connected (live stream, GMGN, SOL price), how many tokens it is
  watching, how many signals it sent.
- **Paste any token CA** → full safety scan with GMGN-style Core Metrics and a verdict.
- `/open` → signals it is following. Sell recommendations arrive as **replies** to each alert.
- Alerts only fire when a token passes every safety check *and* has momentum. Hours with no
  alerts are normal, and most launches get rejected.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Never got "Scanner online" | Check `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID`, then look at Railway logs |
| `/status` shows ❌ Live pump.fun stream | Wrong `HELIUS_API_KEY`, or Helius credits used up (Helius dashboard) |
| Scans show `n/a` for Bundler/Insiders/Rug | `GMGN_API_KEY` missing or wrong. GMGN only accepts IPv4 traffic |
| Helius credits run out fast | Set `ENABLE_PUMPFUN_TRADES=false` (loses SNIPE momentum data), or move to the Developer plan ($49) |

## Any other server (VPS)
```bash
git clone https://github.com/wtmraid/memecoin && cd memecoin
git checkout phase1-ingestion
cp .env.example .env && nano .env      # same variables as above
docker compose up -d --build
docker compose logs -f scanner
```

## Checking performance after a week
Run `npm run report` on the server (Railway: service → *Shell*), or ask for a dashboard.
It shows win rate and average profit per trade (after fees and slippage) per mode and score
bucket. Don't put real money behind it until there are 50+ finished signals with positive
average profit per trade.
