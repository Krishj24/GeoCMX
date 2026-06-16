// /api/news.js  —  Vercel serverless function
// Fetches top geopolitical headlines from GNews API,
// classifies tag + severity, injects commodity impact array.
// Falls back to curated reference events if GNews quota hit.

const GNEWS_KEY = process.env.GNEWS_API_KEY || '';
const CACHE_TTL = 20 * 60 * 1000; // 20 min

let cache = { data: null, ts: 0 };

const SEV_KEYWORDS = {
  critical: ['war declared','nuclear','invasion','attack','strike','missile','killed','troops','seized','blockade','sanctions'],
  high:     ['escalation','conflict','sanction','ban','tariff','crisis','ceasefire','military','threat','protest','coup'],
  moderate: ['tension','dispute','concern','warning','restriction','embargo','freeze'],
  low:      ['talks','diplomacy','negotiation','deal','agreement','summit','visit','statement'],
};

const TAG_KEYWORDS = {
  war:      ['war','attack','strike','missile','troops','killed','military','bomb','airstrike','navy','invasion','ceasefire'],
  sanction: ['sanction','tariff','ban','restrict','embargo','freeze','blacklist','penalty'],
  supply:   ['supply','opec','production','output','shortage','disruption','pipeline','refinery','strike','outage'],
  trade:    ['trade','export','import','deal','agreement','wto','bilateral','tariff','quota'],
  geo:      ['tension','conflict','dispute','protest','coup','election','diplomatic','border'],
};

const COMMODITY_MAP = {
  crude:   { keywords: ['oil','crude','opec','barrel','brent','wti','petroleum','refinery','hormuz','tanker'], dir: 'up' },
  gold:    { keywords: ['gold','safe.haven','conflict','war','inflation','fed','dollar'], dir: 'up' },
  gas:     { keywords: ['gas','lng','pipeline','natgas','energy','heating'], dir: 'up' },
  wheat:   { keywords: ['wheat','grain','ukraine','odesa','food','bread','flour'], dir: 'up' },
  freight: { keywords: ['shipping','freight','container','vessel','red sea','houthi','suez','maersk'], dir: 'up' },
  copper:  { keywords: ['copper','china','manufacturing','industrial','metal'], dir: 'down' },
};

function classify(title, description) {
  const text = (title + ' ' + description).toLowerCase();

  // Tag
  let tag = 'geo';
  let tagScore = 0;
  for (const [t, words] of Object.entries(TAG_KEYWORDS)) {
    const score = words.filter(w => text.includes(w)).length;
    if (score > tagScore) { tagScore = score; tag = t; }
  }

  // Severity
  let sev = 'low';
  for (const [s, words] of Object.entries(SEV_KEYWORDS)) {
    if (words.some(w => text.includes(w))) { sev = s; break; }
  }

  // Affected commodities
  const affected = [];
  for (const [com, { keywords, dir }] of Object.entries(COMMODITY_MAP)) {
    if (keywords.some(k => text.match(new RegExp(k)))) {
      affected.push({ c: com.charAt(0).toUpperCase() + com.slice(1), d: dir });
    }
  }
  if (!affected.length) affected.push({ c: 'Markets', d: 'up' });

  return { tag, sev, affected };
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60)  return mins + 'm ago';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
  return Math.floor(mins / 1440) + 'd ago';
}

function buildPrompt(title, sev, affected) {
  const comList = affected.map(a => a.c).join(', ');
  return `Analyze the commodity and market impact of: "${title}". `
    + `Severity: ${sev.toUpperCase()}. Potentially affected: ${comList}. `
    + `For each commodity, state THEORY (UP/DOWN/NEUTRAL) vs ACTUAL price direction and explain the gap. `
    + `End with: RISK level, one-sentence MARKET IMPACT, and one WATCH indicator.`;
}

const REFERENCE_EVENTS = [
  {title:'US-Iran ceasefire holds week 3 — Oman talks on enrichment cap',tag:'geo',src:'Reuters',age:'2h ago',sev:'high',url:'https://www.reuters.com',affected:[{c:'Crude',d:'down'},{c:'Gold',d:'down'}],prompt:'Analyze US-Iran ceasefire impact on crude oil and gold. Model probability-weighted scenarios for full resolution vs re-escalation.'},
  {title:'Houthi strikes resume — Maersk suspends Red Sea routes again',tag:'war',src:'Lloyd List',age:'4h ago',sev:'critical',url:'https://www.ft.com',affected:[{c:'Freight',d:'up'},{c:'Crude',d:'up'}],prompt:'Houthis struck 2 ships post-ceasefire. Analyze freight rate trajectory and Indian export cost transmission.'},
  {title:'US 145% tariff on China — IMF cuts 2026 global growth to 2.3%',tag:'trade',src:'WSJ',age:'8h ago',sev:'critical',url:'https://www.wsj.com',affected:[{c:'Gold',d:'up'},{c:'Copper',d:'down'}],prompt:'US-China tariff war at 145%/125%. Analyze India trade diversion opportunity vs Chinese dumping risk.'},
  {title:'Gold crosses $3,280 — central bank buying at record pace',tag:'geo',src:'Bloomberg',age:'12h ago',sev:'high',url:'https://www.bloomberg.com',affected:[{c:'Gold',d:'up'},{c:'USD',d:'down'}],prompt:'Gold at $3,280, central banks buying record quantities. Is gold overbought or is de-dollarisation structural?'},
  {title:'RBI cuts repo to 6.0% with accommodative stance',tag:'trade',src:'RBI',age:'1d ago',sev:'moderate',url:'https://www.rbi.org.in',affected:[{c:'INR',d:'up'}],prompt:'RBI cut 25bp to 6.0%. Analyze transmission into housing finance, NBFCs, auto, and PSU banks.'},
  {title:'China seizes Philippines supply mission at Second Thomas Shoal',tag:'geo',src:'SCMP',age:'2d ago',sev:'critical',url:'https://www.scmp.com',affected:[{c:'Crude',d:'up'},{c:'Gold',d:'up'}],prompt:'China seized Philippines supply mission. Analyze Taiwan Strait escalation risk and semiconductor supply chain vulnerability.'},
  {title:'Russia recaptures Kursk, Sumy under sustained drone attacks',tag:'war',src:'AP',age:'2d ago',sev:'high',url:'https://apnews.com',affected:[{c:'Wheat',d:'up'},{c:'Gas',d:'up'}],prompt:'Russia recaptured Kursk, NATO Article 4 activated. Analyze European nat gas, wheat corridor, and Indian steel export implications.'},
  {title:'India SPR fully stocked at $89 Brent — Phase 2 expansion approved',tag:'supply',src:'PIB',age:'3d ago',sev:'low',url:'https://pib.gov.in',affected:[{c:'Crude',d:'down'}],prompt:'India filled SPR at $89 Brent. Analyze energy security improvement and OMC re-rating implications.'},
];

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Serve cache if fresh
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  if (!GNEWS_KEY) {
    return res.status(200).json({ news: REFERENCE_EVENTS, lastFetched: new Date().toISOString(), source: 'reference' });
  }

  try {
    const queries = ['geopolitical war sanctions oil', 'india macro economy trade', 'opec china us tariff'];
    const allArticles = [];

    for (const q of queries) {
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=5&apikey=${GNEWS_KEY}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'GeoIntelTerminal/2.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.articles) allArticles.push(...d.articles);
    }

    if (!allArticles.length) throw new Error('no articles');

    // Deduplicate by title
    const seen = new Set();
    const news = allArticles
      .filter(a => {
        const key = a.title.slice(0, 60);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12)
      .map(a => {
        const { tag, sev, affected } = classify(a.title, a.description || '');
        return {
          title: a.title,
          tag,
          src: a.source?.name || 'News',
          age: timeAgo(a.publishedAt),
          sev,
          url: a.url,
          affected,
          prompt: buildPrompt(a.title, sev, affected),
        };
      });

    const payload = { news, lastFetched: new Date().toISOString(), source: 'live' };
    cache = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);

  } catch (e) {
    return res.status(200).json({ news: REFERENCE_EVENTS, lastFetched: new Date().toISOString(), source: 'reference' });
  }
}
