# GeoIntel Terminal v2 — Vercel Deployment Guide

---

## What's in this package

```
geointel-deploy/
├── api/
│   ├── news.js       ← GeoIntel Feed — GNews + classification engine
│   ├── macro.js      ← India Macro — Stooq prices + RBI/MoSPI fundamentals
│   ├── stocks.js     ← NSE Watchlist — Stooq live prices, 12 stocks
│   └── analyze.js    ← AI Analysis — proxies Groq LLaMA 3.3, key never touches the browser
├── public/
│   └── index.html    ← Entire frontend (self-contained, no build step)
├── vercel.json       ← Routing + headers config
├── package.json
└── DEPLOY.md         ← This file
```

---

## Step 1 — Create free Vercel account

Go to https://vercel.com → Sign up with GitHub (recommended) or email.
Free Hobby plan is sufficient. No credit card required.

---

## Step 2 — Install Vercel CLI

Open terminal (PowerShell / Terminal / CMD):

```bash
npm install -g vercel
```

If you don't have Node.js: download from https://nodejs.org (LTS version).

---

## Step 3 — Login

```bash
vercel login
```

A browser window opens. Click "Continue with GitHub" (or email). Done.

---

## Step 4 — Set your API keys (both optional but strongly recommended)

**GNews key** — get a free key at https://gnews.io → Register → Dashboard → API Key.
Free tier = 100 requests/day. Enough for the GeoIntel Feed to pull live news.

```bash
cd geointel-deploy
vercel env add GNEWS_API_KEY
```

**Groq key** — get a free key at https://console.groq.com (14,400 req/day free).
Powers the in-terminal AI Analysis feature. The key is read server-side by
`api/analyze.js` and is never exposed to the browser.

```bash
vercel env add GROQ_API_KEY
```

For both: paste your key when prompted, and select all three environments
(Production, Preview, Development).

> WITHOUT a GNews key: The GeoIntel Feed shows curated reference events.
> WITHOUT a Groq key: AI Analysis falls back to a "open in Claude.ai" link.
> Everything else (Macro, Stocks, Calendar, War Intel, India+Tech) works fully.

> ⚠️ **Security note:** Never paste API keys directly into `index.html` or any
> file that gets committed to git. Keys belong in Vercel environment variables
> only, where serverless functions like `api/analyze.js` can read them via
> `process.env` without ever shipping them to the client.

---

## Step 5 — Deploy

```bash
cd geointel-deploy
vercel --prod
```

Vercel auto-detects the structure, deploys in ~30 seconds, and gives you:

```
✅ Production: https://geointel-terminal.vercel.app
```

Your URL will be something like `geointel-YOUR-NAME.vercel.app`.
You can also set a custom domain from the Vercel dashboard for free.

---

## Data sources — what actually powers each tab now

| Tab | Source | Requires key? |
|-----|--------|---------------|
| GeoIntel Feed | GNews API (live) → reference fallback | GNews key (free) |
| Commodity Data | TradingView ticker widget (browser-side, no key) | No |
| War Intel | Curated April 2026 reference data (12 cards) | No |
| India + Tech | Curated April 2026 reference data (8 cards) | No |
| India Macro | Stooq (live) → reference fallback | No |
| NSE Watchlist | Stooq (live) → reference fallback | No |
| Econ Calendar | Static April–June 2026 with real actuals | No |
| AI Analysis | Groq LLaMA 3.3 (proxied server-side via `/api/analyze`) | Groq key ✓ |

**Stooq** (stooq.com) is a free market data provider — no API key, no rate limits,
server-side fetch so no CORS issues. It provides: Sensex, Nifty 50, Nifty Bank,
USD/INR, Gold ETF, Brent Crude, and all 12 NSE stocks.

---

## Redeployment (after editing files)

Every time you update `index.html` or any `api/*.js` file:

```bash
vercel --prod
```

Takes 20-30 seconds. Zero downtime.

---

## Environment variables reference

| Variable | Where to get | Required |
|----------|-------------|----------|
| `GNEWS_API_KEY` | gnews.io dashboard | Optional |
| `GROQ_API_KEY` | console.groq.com dashboard | Optional |

Both keys are set as Vercel environment variables and read server-side only —
neither one ever appears in `index.html` or any other file in this repo.

---

## Limits on Vercel free (Hobby) plan

| Resource | Limit | Your usage |
|----------|-------|-----------|
| Bandwidth | 100 GB/month | ~0.1 GB (tiny static file) |
| Serverless function invocations | 100,000/month | ~few hundred/day |
| Function execution time | 10s max | Your APIs run in <2s |
| Domains | Unlimited subdomains | Free |

You will **never hit these limits** with a personal terminal.

---

## Troubleshooting

**"Command not found: vercel"**
→ Run `npm install -g vercel` first. If npm not found, install Node.js.

**Deployment succeeds but /api/news returns reference data**
→ GNews key not set or quota hit. Reference data is intentional fallback — not an error.

**Macro tab shows amber dot**
→ Stooq may be slow. Wait 10s and refresh. If persistent, reference data loads automatically.

**Stock prices show "Reference Apr 17"**
→ Stooq is down or rate-limited. Not a code error — data is still useful.

**Want to update the curated War Intel / India+Tech content**
→ Edit `WAR_FALLBACK` and `INDIA_FALLBACK` arrays in `index.html`, then `vercel --prod`.

---

## Moving from Railway

Your old Railway backend is now fully replaced by:
- 3 Vercel serverless functions in `/api/`
- Stooq instead of Yahoo Finance (no auth, no CORS, more reliable)
- GNews (same as before, same key works)

The frontend `BACKEND_URL` is now `''` (empty string) — all API calls go to
`/api/news`, `/api/macro`, `/api/stocks` on the same Vercel domain automatically.
No changes needed when your Vercel URL changes.
