// /api/stocks.js  —  Vercel serverless function
// Fetches NSE stock prices from Stooq (free, no API key needed).
// Falls back to reference data if Stooq is unavailable.
// Returns data in the exact shape the frontend renderWatchlist() expects.

const CACHE_TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };

// NSE stocks — Stooq uses .ns suffix for NSE
const WATCHLIST = [
  { symbol: 'RELIANCE',  stooq: 'reliance.ns',  name: 'Reliance Industries', sector: 'Conglomerate', pe: 24.1 },
  { symbol: 'TCS',       stooq: 'tcs.ns',        name: 'Tata Consultancy',    sector: 'IT',           pe: 28.6 },
  { symbol: 'HDFCBANK',  stooq: 'hdfcbank.ns',   name: 'HDFC Bank',           sector: 'Banking',      pe: 17.2 },
  { symbol: 'INFY',      stooq: 'infy.ns',        name: 'Infosys',             sector: 'IT',           pe: 22.4 },
  { symbol: 'ICICIBANK', stooq: 'icicibank.ns',   name: 'ICICI Bank',          sector: 'Banking',      pe: 16.8 },
  { symbol: 'SBI',       stooq: 'sbin.ns',        name: 'State Bank of India', sector: 'PSU Bank',     pe: 10.4 },
  { symbol: 'WIPRO',     stooq: 'wipro.ns',       name: 'Wipro',               sector: 'IT',           pe: 19.8 },
  { symbol: 'HPCL',      stooq: 'hindpetro.ns',   name: 'HPCL',                sector: 'OMC',          pe: 8.2  },
  { symbol: 'BPCL',      stooq: 'bpcl.ns',        name: 'BPCL',                sector: 'OMC',          pe: 7.6  },
  { symbol: 'SUNPHARMA', stooq: 'sunpharma.ns',   name: 'Sun Pharma',          sector: 'Pharma',       pe: 31.2 },
  { symbol: 'MARUTI',    stooq: 'maruti.ns',       name: 'Maruti Suzuki',       sector: 'Auto',         pe: 26.4 },
  { symbol: 'BEL',       stooq: 'bel.ns',          name: 'Bharat Electronics',  sector: 'Defence',      pe: 38.6 },
];

const REFERENCE_STOCKS = [
  { symbol: 'RELIANCE',  name: 'Reliance Industries', sector: 'Conglomerate', price: '2,847', chg: '+1.2%', chgAbs: '+33.8', volume: '8.2M', pe: '24.1', up: true  },
  { symbol: 'TCS',       name: 'Tata Consultancy',    sector: 'IT',           price: '3,512', chg: '-2.4%', chgAbs: '-86.2', volume: '3.1M', pe: '28.6', up: false },
  { symbol: 'HDFCBANK',  name: 'HDFC Bank',           sector: 'Banking',      price: '1,748', chg: '+0.6%', chgAbs: '+10.4', volume: '12.1M',pe: '17.2', up: true  },
  { symbol: 'INFY',      name: 'Infosys',             sector: 'IT',           price: '1,421', chg: '-3.1%', chgAbs: '-45.3', volume: '9.4M', pe: '22.4', up: false },
  { symbol: 'ICICIBANK', name: 'ICICI Bank',          sector: 'Banking',      price: '1,312', chg: '+1.8%', chgAbs: '+23.2', volume: '10.8M',pe: '16.8', up: true  },
  { symbol: 'SBI',       name: 'State Bank of India', sector: 'PSU Bank',     price: '812',   chg: '+2.8%', chgAbs: '+22.1', volume: '18.3M',pe: '10.4', up: true  },
  { symbol: 'HPCL',      name: 'HPCL',                sector: 'OMC',          price: '378',   chg: '+3.6%', chgAbs: '+13.1', volume: '14.7M',pe: '8.2',  up: true  },
  { symbol: 'BPCL',      name: 'BPCL',                sector: 'OMC',          price: '322',   chg: '+2.9%', chgAbs: '+9.1',  volume: '11.2M',pe: '7.6',  up: true  },
  { symbol: 'SUNPHARMA', name: 'Sun Pharma',          sector: 'Pharma',       price: '1,680', chg: '+1.4%', chgAbs: '+23.2', volume: '4.2M', pe: '31.2', up: true  },
  { symbol: 'MARUTI',    name: 'Maruti Suzuki',       sector: 'Auto',         price: '12,340',chg: '+2.1%', chgAbs: '+253.9',volume: '0.9M', pe: '26.4', up: true  },
  { symbol: 'BEL',       name: 'Bharat Electronics',  sector: 'Defence',      price: '312',   chg: '+4.2%', chgAbs: '+12.6', volume: '22.4M',pe: '38.6', up: true  },
  { symbol: 'WIPRO',     name: 'Wipro',               sector: 'IT',           price: '487',   chg: '-1.9%', chgAbs: '-9.4',  volume: '6.8M', pe: '19.8', up: false },
];

async function fetchStooqPrice(stooqSym) {
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'GeoIntelTerminal/2.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(',');
    const close = parseFloat(parts[6]);
    const open  = parseFloat(parts[3]);
    const vol   = parseInt(parts[7], 10);
    if (isNaN(close) || close === 0) return null;
    const chgAbs = close - open;
    const chgPct = (chgAbs / open * 100);
    const up = chgPct >= 0;
    return { close, chgAbs, chgPct, vol, up };
  } catch {
    return null;
  }
}

function fmtPrice(n) {
  if (n >= 10000) return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (n >= 1000)  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  if (n >= 100)   return n.toFixed(2);
  return n.toFixed(2);
}

function fmtVol(n) {
  if (!n || isNaN(n)) return '—';
  if (n >= 1e7) return (n / 1e7).toFixed(1) + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(1) + 'L';
  return n.toLocaleString();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  // Fetch all stocks in parallel
  const results = await Promise.all(WATCHLIST.map(s => fetchStooqPrice(s.stooq)));

  const liveFetched = results.filter(Boolean).length;

  // If Stooq returned nothing at all, serve reference
  if (liveFetched === 0) {
    return res.status(200).json({ stocks: REFERENCE_STOCKS, source: 'reference', lastFetched: new Date().toISOString() });
  }

  const stocks = WATCHLIST.map((s, i) => {
    const d = results[i];
    if (!d) {
      // Use reference fallback for this individual stock
      const ref = REFERENCE_STOCKS.find(r => r.symbol === s.symbol);
      return ref || null;
    }
    const sign = d.up ? '+' : '';
    return {
      symbol:  s.symbol,
      name:    s.name,
      sector:  s.sector,
      price:   fmtPrice(d.close),
      chg:     sign + d.chgPct.toFixed(2) + '%',
      chgAbs:  sign + d.chgAbs.toFixed(2),
      volume:  fmtVol(d.vol),
      pe:      s.pe.toString(),
      up:      d.up,
    };
  }).filter(Boolean);

  const payload = {
    stocks,
    source: liveFetched >= WATCHLIST.length * 0.5 ? 'live' : 'partial',
    lastFetched: new Date().toISOString(),
  };
  cache = { data: payload, ts: Date.now() };
  return res.status(200).json(payload);
}
