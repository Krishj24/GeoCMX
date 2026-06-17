// /api/commodities.js  —  Vercel serverless function
// Live commodity quotes via Twelve Data (https://twelvedata.com), batched into
// a single request to stay well inside the free tier's 800 req/day, 8 req/min
// limits (this endpoint is cached 5 min, so worst case ~288 calls/day).
//
// Falls back per-symbol to the terminal's static reference prices if Twelve
// Data doesn't have a symbol on the free plan, errors, or the key is missing —
// never returns an error to the client, same pattern as api/stocks.js / api/macro.js.

const CACHE_TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };

// Twelve Data symbol per commodity id. Metals + WTI/Brent are spot FX-style
// pairs (confirmed live on Twelve Data's free-tier-eligible forex/commodity
// feed). The futures-style softs/grains/meats symbols are best-effort guesses
// from Twelve Data's commodity list — if the account's plan doesn't include
// one, that single symbol fails gracefully and falls back to the reference
// price below, it won't break the rest.
const SYMBOL_MAP = {
  gold:       'XAU/USD',
  silver:     'XAG/USD',
  copper:     'XCU/USD',
  platinum:   'XPT/USD',
  palladium:  'XPD/USD',
  brent:      'XBR/USD',
  wti:        'WTI/USD',
  natgas:     'NATGAS',
  heatingoil: 'HEATOIL',
  wheat:      'WHEAT',
  corn:       'CORN',
  soybeans:   'SOYBEAN',
  rice:       'RICE',
  coffee:     'COFFEE',
  sugar:      'SUGAR',
  cotton:     'COTTON',
  cocoa:      'COCOA',
  cattle:     'CATTLE',
  hogs:       'HOGS',
};

// Static reference values — mirrors the COMMODITIES array baked into
// public/index.html, used only when Twelve Data can't supply a symbol.
const REFERENCE = {
  gold:       { price: '2318',   chg: '+0.6%',  up: true  },
  silver:     { price: '27.50',  chg: '+1.1%',  up: true  },
  copper:     { price: '4.23',   chg: '-0.3%',  up: false },
  platinum:   { price: '985',    chg: '+0.4%',  up: true  },
  palladium:  { price: '1020',   chg: '-1.2%',  up: false },
  brent:      { price: '82.40',  chg: '+1.2%',  up: true  },
  wti:        { price: '78.20',  chg: '+0.9%',  up: true  },
  natgas:     { price: '2.91',   chg: '-0.8%',  up: false },
  heatingoil: { price: '2.68',   chg: '-0.5%',  up: false },
  wheat:      { price: '5.82',   chg: '+3.1%',  up: true  },
  corn:       { price: '4.65',   chg: '+0.8%',  up: true  },
  soybeans:   { price: '11.85',  chg: '+0.5%',  up: true  },
  rice:       { price: '17.20',  chg: '+1.4%',  up: true  },
  coffee:     { price: '2.15',   chg: '+0.7%',  up: true  },
  sugar:      { price: '0.2280', chg: '-1.2%',  up: false },
  cotton:     { price: '0.8450', chg: '+0.3%',  up: true  },
  cocoa:      { price: '9850',   chg: '+2.1%',  up: true  },
  cattle:     { price: '1.8650', chg: '+0.5%',  up: true  },
  hogs:       { price: '0.8820', chg: '-0.8%',  up: false },
};

function fmtPrice(n) {
  if (n == null || isNaN(n)) return null;
  if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 100)  return n.toFixed(2);
  if (n >= 10)   return n.toFixed(3);
  return n.toFixed(4);
}

async function fetchTwelveDataBatch(symbols, apiKey) {
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbols.join(','))}&apikey=${apiKey}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return null;
    const data = await r.json();
    // Single-symbol requests return the quote object directly; multi-symbol
    // batch requests return { "SYMBOL": {...quote}, "SYMBOL2": {...} }
    if (symbols.length === 1) return { [symbols[0]]: data };
    return data;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY;
  const ids = Object.keys(SYMBOL_MAP);

  let batch = null;
  if (apiKey) {
    const symbols = ids.map(id => SYMBOL_MAP[id]);
    batch = await fetchTwelveDataBatch(symbols, apiKey);
  }

  let liveCount = 0;
  const commodities = {};
  for (const id of ids) {
    const sym = SYMBOL_MAP[id];
    const q = batch && batch[sym];
    const close = q && q.close != null ? parseFloat(q.close) : NaN;
    const pct   = q && q.percent_change != null ? parseFloat(q.percent_change) : NaN;

    if (q && !q.code && !isNaN(close) && !isNaN(pct)) {
      const up = pct >= 0;
      commodities[id] = {
        price: fmtPrice(close),
        chg: (up ? '+' : '') + pct.toFixed(2) + '%',
        up,
      };
      liveCount++;
    } else {
      const ref = REFERENCE[id];
      commodities[id] = ref ? { ...ref, reference: true } : null;
    }
  }

  const payload = {
    commodities,
    source: liveCount === 0 ? 'reference' : (liveCount >= ids.length * 0.5 ? 'live' : 'partial'),
    liveCount,
    total: ids.length,
    lastFetched: new Date().toISOString(),
  };

  cache = { data: payload, ts: Date.now() };
  return res.status(200).json(payload);
}
