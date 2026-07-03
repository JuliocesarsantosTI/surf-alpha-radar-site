# Surf Alpha Radar

A **local-first crypto research copilot** built on the [Surf](https://asksurf.ai) CLI. It turns raw Surf data into a transparent **Alpha Score**, a plain-language **Signal Read**, and a live **Crypto Pulse** dashboard — running entirely on your own machine with your own Surf credits.

There's no backend to host and no shared server: the app talks to a tiny local connector that runs the Surf CLI you already have installed. Every request uses *your* credits, so it costs nothing to run and keeps your key on your machine.

> **Not financial advice.** Surf Alpha Radar is an information tool. Always do your own research.

---

## Why it's different

Most crypto tools either give you a black-box "score" or a wall of raw numbers. Surf Alpha Radar shows **exactly where every point comes from**: each Alpha Score segment maps to a real Surf signal, and the Signal Read explains the "why" in plain language — backed by live data like ETF flows, open interest, and on-chain activity.

---

## Features

- **Transparent Alpha Score (0–100)** — a segmented gauge where every input is visible and sourced from Surf CLI: price momentum, RSI technicals, market Fear & Greed, social attention, on-chain activity, and news attention.
- **Instant vs Research modes** — `Instant` (~3 credits) runs price, RSI and Fear & Greed for a fast read; `Research` (~6–9 credits) adds social, on-chain, ETF flows, open interest, funding and long/short. Upgrade an Instant scan to Research from the result.
- **Narrative TL;DR + Signal Read** — a plain-language summary generated from the real signals, plus specific data lines (ETF net flow, open interest, funding, long/short ratio) where available.
- **Risk Scan** — liquidity, creator wallet, honeypot and holder-concentration checks.
- **Crypto Pulse dashboard** — live market Fear & Greed (with history), mindshare sentiment, and the top mindshare leaders.
- **Free-form questions** — ask something that isn't a token (e.g. *"what is the best crypto dex?"*) and it runs a web search via Surf instead of erroring.
- **Credit-safe by design** — opening the app spends **zero credits**. Rankings and Pulse load only on click and cache in your browser for 30 minutes; past chats reopen instantly from a local snapshot (0 credits) with an optional **↻ Refresh** for fresh data.

---

## Architecture

```
Browser (the web app)  ──►  Local Connector  ──►  Surf CLI  ──►  Surf API
   http://127.0.0.1:8787      Node, zero deps        your key / your credits
```

1. **Web app** (`web/`) — the interface. Sends your question to the connector.
2. **Local Connector** (`server.js`, `surf.js`) — a small zero-dependency Node server. It runs Surf CLI commands, parses the results, computes the Alpha Score, and caches responses.
3. **Surf CLI** — the data engine. Everything is billed to your own Surf account, on your own machine.

The connector binds to `127.0.0.1` only, so nothing is exposed to your network.

---

## Requirements

- **[Node.js](https://nodejs.org) 18+**
- **Surf CLI**, installed and authenticated. Install it and run `surf auth` first. Verify with:
  ```bash
  surf --version
  ```

> **Windows note:** the Surf CLI is typically a Git-Bash program. The connector auto-detects Git Bash and runs Surf through it, so start the connector from a normal terminal or Git Bash — either works.

---

## Quick start

```bash
# 1. clone
git clone https://github.com/<your-username>/surf-alpha-radar.git
cd surf-alpha-radar

# 2. run the connector (no npm install needed — zero dependencies)
npm start

# 3. open the app
#    → http://127.0.0.1:8787
```

You should see:

```
  Surf Alpha Radar — Local Connector
  Web app:  http://127.0.0.1:8787
  health:   http://127.0.0.1:8787/health
  surf runner: bash (C:\Program Files\Git\bin\bash.exe)
```

Then try `Analyze SOL`, `$PEPE`, `Compare AAVE and LINK`, or open **Crypto Pulse**.

### Configuration (optional)

| Env var | Purpose |
| --- | --- |
| `PORT` | Change the port (default `8787`). |
| `SURF_BIN` | Full path to the `surf` binary if it isn't auto-detected. |
| `SURF_BASH` | Full path to `bash.exe` on Windows if Git Bash isn't found automatically. |

Example:

```bash
SURF_BIN="/c/Users/you/.local/bin/surf" npm start
```

---

## Live vs estimated data

The app is honest about its inputs. Most signals are **live from Surf CLI**; a few are **estimated** and clearly marked with a `~` and dimmed in the UI:

| Signal | Source | Notes |
| --- | --- | --- |
| Price & momentum | `market-price` | live |
| Technicals (RSI) | `market-price-indicator` | live |
| Market sentiment | `market-fear-greed` | live |
| Social attention | `social-detail` | live (Research mode) |
| On-chain activity | `token-transfer-stats` | live for **EVM** tokens; estimated for non-EVM (BTC, SOL) |
| News attention | `news-feed` | live (Research mode) |
| ETF / OI / long-short | `market-etf`, `exchange-perp`, `exchange-long-short-ratio` | live where the asset has them |
| Risk Scan | heuristic | estimated |

---

## Credits

Surf CLI provides **30 free credits per day per IP**; larger plans are available from Surf. To stay light:

- Opening the app costs **0 credits**.
- `Instant` scans are ~3 credits; `Research` scans are ~6–9.
- Rankings, Pulse and past chats are cached, so revisiting them doesn't re-spend.

---

## Diagnostics

If a scan fails, the connector prints the real reason, and these endpoints help:

- `GET /health` — is the connector up?
- `GET /diag` — checks that Surf CLI is callable and shows a sample of its output.

---

## Project layout

```
surf-alpha-radar/
├── server.js        # local HTTP server: static site + API + cache
├── surf.js          # Surf CLI runner, parsers, Alpha Score, TL;DR
├── package.json
└── web/
    ├── index.html   # sidebar + home + result + pulse + about
    ├── app.css
    └── app.js       # routing, rendering, browser cache & history
```

---

## Roadmap

- Make the estimated Risk Scan live via wallet/holder endpoints.
- Broaden on-chain coverage beyond EVM.
- A browser extension for the same analysis inline on any page *(in progress)*.

---

## License

MIT — see [`LICENSE`](LICENSE).

Built on [Surf](https://asksurf.ai). Not affiliated with or endorsed by Surf.
