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
// Update this object whenever key data is released
const FUNDAMENTALS = {
  cpi:        { label: 'CPI YoY (Mar 2026)',  value: '3.34%',  sub: 'MoSPI — Apr 14 2026',     color: 'mup'  },
  repoRate:   { label: 'Repo Rate',            value: '6.00%',  sub: 'RBI cut 25bp — Apr 9',     color: 'mup'  },
  gdp:        { label: 'GDP Q4 FY2026',        value: '6.7%',   sub: 'FY26 full year 6.5%',      color: 'mup'  },
  petrolDelhi:{ label: 'Petrol Delhi',         value: 'Rs 94.72', sub: 'No revision since Oct 24', color: 'mwarn'},
  dieselDelhi:{ label: 'Diesel Delhi',         value: 'Rs 87.62', sub: 'No revision since Oct 24', color: 'mwarn'},
  lpg:        { label: 'LPG Cylinder',         value: 'Rs 803',   sub: '14.2kg Delhi — Mar 2026',  color: 'mwarn'},
  crudeImport:{ label: 'India Crude Basket',   value: '$88.6',    sub: 'PPAC reference — Apr 17',  color: 'mup'  },
  hormuz:     { label: 'Hormuz Status',        value: 'Open',     sub: 'Reopened Apr 3 2026',      color: 'mup'  },
  fiiFlows:   { label: 'FII Flows Apr',        value: '+Rs 24,600 cr', sub: 'Apr 1-17 net buying', color: 'mup'  },
  diiFlows:   { label: 'DII Flows Apr',        value: '+Rs 31,200 cr', sub: 'Apr 1-17 cumulative',  color: 'mup'  },
  rbiWatch:   { value: 'RBI cut repo to 6.00% (Apr 9) with ACCOMMODATIVE stance — signalling further easing. FX reserves $673B (11.8 months import cover). CPI trajectory: 3.34% Mar → ~3.5% Apr (seasonal). Next MPC: June 2026. Market pricing 2 more 25bp cuts in FY27.' },
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
