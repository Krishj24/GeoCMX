// /api/macro.js  —  Vercel serverless function
// Sources:
//   Market data  → Stooq (free, no key, CORS-friendly via server-side fetch)
//   India VIX    → NSE official JSON (live)
//   FII/DII flows → NSE official JSON (live)
//   Other fundamentals (CPI/repo/GDP/fuel/LPG) → hardcoded from RBI/MoSPI/PIB/PPAC
//     (no free live JSON source exists for these — PPAC only publishes PDFs;
//     update this object manually whenever new data is released)
//   Brent        → from /api/prices or Stooq
// Falls back gracefully on every failure — never returns an error to the client.

const CACHE_TTL = 5 * 60 * 1000; // 5 min
let cache = { data: null, ts: 0 };

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// NSE blocks requests without a valid session cookie. Visit the homepage once
// to get one, then reuse it for the actual API calls.
async function getNseCookie() {
  try {
    const r = await fetch('https://www.nseindia.com/', {
      headers: { ...NSE_HEADERS, 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(5000),
    });
    const cookie = (r.headers.getSetCookie && r.headers.getSetCookie().length)
      ? r.headers.getSetCookie().join('; ')
      : (r.headers.get('set-cookie') || '');
    return cookie;
  } catch {
    return '';
  }
}

async function fetchNse(path, cookie) {
  try {
    const r = await fetch('https://www.nseindia.com' + path, {
      headers: { ...NSE_HEADERS, 'Referer': 'https://www.nseindia.com/', ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchIndiaVix(cookie) {
  const data = await fetchNse('/api/allIndices', cookie);
  const list = data && Array.isArray(data.data) ? data.data : null;
  if (!list) return null;
  const vix = list.find(i => i.indexSymbol === 'INDIA VIX' || i.index === 'INDIA VIX');
  if (!vix || typeof vix.last !== 'number') return null;
  return { close: vix.last, chgPct: vix.percentChange, up: vix.percentChange >= 0 };
}

function fmtFlow(netValueStr) {
  const v = parseFloat(netValueStr);
  if (isNaN(v)) return null;
  const sign = v >= 0 ? '+' : '-';
  return sign + 'Rs ' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) + ' cr';
}

async function fetchFiiDii(cookie) {
  const data = await fetchNse('/api/fiidiiTradeReact', cookie);
  if (!Array.isArray(data)) return null;
  const fii = data.find(d => d.category === 'FII/FPI' || d.category === 'FII');
  const dii = data.find(d => d.category === 'DII');
  if (!fii && !dii) return null;
  return { fii, dii };
}

// Stooq symbols for Indian markets
const STOOQ_SYMBOLS = {
  sensex:    '^bsesn',
  nifty50:   '^nsei',
  niftyBank: '^nsebank',
  usdInr:    'usd/inr',
  goldbees:  'goldbees.ns', // NSE-listed ETF
  brent:     'brent.f',
};

async function fetchStooq(symbol) {
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetch(url, { headers: { 'User-Agent': 'GeoIntelTerminal/2.0' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(',');
    // CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = parseFloat(parts[6]);
    const open  = parseFloat(parts[3]);
    if (isNaN(close) || close === 0) return null;
    const chgPct = ((close - open) / open * 100);
    const up = chgPct >= 0;
    return { close, chgPct, up };
  } catch {
    return null;
  }
}

function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 10000) return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (n >= 100)   return n.toFixed(2);
  if (n >= 10)    return n.toFixed(3);
  return n.toFixed(4);
}

function colorFor(up) { return up ? 'mup' : 'mdn'; }

function marketCard(label, data, bigNum = false) {
  if (!data) return { label, value: '—', sub: 'No data', color: 'mwarn' };
  const sign = data.up ? '+' : '';
  return {
    label,
    value: bigNum ? data.close.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : fmt(data.close),
    sub: sign + data.chgPct.toFixed(2) + '% today',
    color: colorFor(data.up),
  };
}

// Hardcoded fundamentals — sourced from RBI/MoSPI/PIB
// No free live JSON feed exists for these (PPAC/MoSPI only publish PDFs/HTML),
// so they are refreshed manually from verified reporting. Last refreshed
// 2026-06-17 against MoSPI, RBI MPC (Jun 5 2026) and pump-price reporting.
const FUNDAMENTALS = {
  cpi:        { label: 'CPI YoY (May 2026)',  value: '3.93%',  sub: 'MoSPI — released Jun 12 2026', color: 'mup'  },
  repoRate:   { label: 'Repo Rate',            value: '5.25%',  sub: 'RBI MPC Jun 5 — held, Neutral stance', color: 'mup'  },
  gdp:        { label: 'GDP Q4 FY2026',        value: '7.8%',   sub: 'FY26 full year 7.7%',      color: 'mup'  },
  petrolDelhi:{ label: 'Petrol Delhi',         value: 'Rs 102.12', sub: 'As of Jun 16 2026', color: 'mwarn'},
  dieselDelhi:{ label: 'Diesel Delhi',         value: 'Rs 95.20',  sub: 'As of Jun 16 2026', color: 'mwarn'},
  lpg:        { label: 'LPG Cylinder',         value: 'Rs 942',   sub: '14.2kg Delhi — Jun 16 2026 (+Rs29 m/m)', color: 'mwarn'},
  crudeImport:{ label: 'India Crude Basket',   value: '$88.6',    sub: 'PPAC reference (overwritten by live Brent below if available)', color: 'mup'  },
  hormuz:     { label: 'Hormuz Status',        value: 'Effectively closed', sub: 'Conditional ceasefire; ~95% crude / ~99% LNG volume drop vs normal', color: 'mdn' },
  fiiFlows:   { label: 'FII Flows (H1 CY26)',  value: '-Rs 2.8 lakh cr', sub: 'Net selling, Jan-Jun 9 2026 — NSDL', color: 'mdn'  },
  diiFlows:   { label: 'DII Flows (H1 CY26)',  value: '+Rs 4.3 lakh cr', sub: 'Record net buying, Jan-Jun 9 2026', color: 'mup'  },
  rbiWatch:   { value: 'RBI MPC (Jun 5 2026) held repo at 5.25% with a NEUTRAL stance, citing CPI below target but with an upward bias. May CPI printed 3.93% YoY (food 4.78%), up from April. Q4 FY26 GDP surprised at 7.8%, full-year FY26 growth 7.7%. DIIs have been absorbing a historic wave of FPI selling — DII net buying of Rs 4.3 lakh cr in H1 CY26 against FPI net selling of Rs 2.8 lakh cr over the same period.' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  // One NSE session cookie, reused for both NSE calls below
  const nseCookie = await getNseCookie();

  // Fetch market data + NSE live feeds in parallel
  const [sensexD, niftyD, niftyBankD, usdInrD, goldbeesD, brentD, indiaVixD, fiiDiiD] = await Promise.all([
    fetchStooq(STOOQ_SYMBOLS.sensex),
    fetchStooq(STOOQ_SYMBOLS.nifty50),
    fetchStooq(STOOQ_SYMBOLS.niftyBank),
    fetchStooq(STOOQ_SYMBOLS.usdInr),
    fetchStooq(STOOQ_SYMBOLS.goldbees),
    fetchStooq(STOOQ_SYMBOLS.brent),
    fetchIndiaVix(nseCookie),
    fetchFiiDii(nseCookie),
  ]);

  // IndiaVIX — live from NSE; reference only if NSE is unreachable
  const indiaVixFallback = { close: 15.2, chgPct: -0.8, up: false };

  const market = {
    sensex:    marketCard('Sensex',     sensexD    || { close: 80110, chgPct: 0.3,  up: true }, true),
    nifty50:   marketCard('Nifty 50',   niftyD     || { close: 24280, chgPct: 0.4,  up: true }, true),
    niftyBank: marketCard('Nifty Bank', niftyBankD || { close: 52840, chgPct: 0.6,  up: true }, true),
    usdInr:    marketCard('USD/INR',    usdInrD    || { close: 87.82, chgPct: -0.2, up: true }),
    indiaVix:  marketCard('India VIX',  indiaVixD  || indiaVixFallback),
    goldbees:  marketCard('Gold ETF',   goldbeesD  || { close: 928,   chgPct: 0.5,  up: true }),
  };

  // Brent — attach to fundamentals too
  if (brentD) {
    FUNDAMENTALS.crudeImport = {
      label: 'Brent Crude (live)',
      value: '$' + brentD.close.toFixed(2),
      sub: (brentD.up ? '+' : '') + brentD.chgPct.toFixed(2) + '% today · Stooq',
      color: colorFor(brentD.up),
    };
  }

  // FII/DII flows — live from NSE; keep hardcoded reference if NSE is unreachable
  if (fiiDiiD && fiiDiiD.fii) {
    const net = parseFloat(fiiDiiD.fii.netValue);
    FUNDAMENTALS.fiiFlows = {
      label: 'FII Flows (live)',
      value: fmtFlow(fiiDiiD.fii.netValue),
      sub: fiiDiiD.fii.date + ' · ' + (net >= 0 ? 'net buying' : 'net selling') + ' · NSE',
      color: net >= 0 ? 'mup' : 'mdn',
    };
  }
  if (fiiDiiD && fiiDiiD.dii) {
    const net = parseFloat(fiiDiiD.dii.netValue);
    FUNDAMENTALS.diiFlows = {
      label: 'DII Flows (live)',
      value: fmtFlow(fiiDiiD.dii.netValue),
      sub: fiiDiiD.dii.date + ' · ' + (net >= 0 ? 'net buying' : 'net selling') + ' · NSE',
      color: net >= 0 ? 'mup' : 'mdn',
    };
  }

  const payload = {
    market,
    fundamentals: FUNDAMENTALS,
    lastFetched: new Date().toISOString(),
    source: (sensexD || niftyD) ? 'live' : 'reference',
  };

  cache = { data: payload, ts: Date.now() };
  return res.status(200).json(payload);
}
