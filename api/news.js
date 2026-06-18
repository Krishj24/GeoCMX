// /api/news.js  —  Vercel serverless function
// Fetches headlines from GNews API, then runs them through an LLM relevance
// gate (Groq, same key already used for War Intel analysis) that decides
// whether each headline is genuinely market/geopolitically relevant before
// it's tagged with a category, severity, or commodity impact.
//
// Why: GNews's broad keyword search (e.g. "india OR rbi OR ...") will match
// any article containing one of those words, including pure sports/entertainment
// stories. The old pipeline then force-classified every article — even
// ones with zero real signal — defaulting to tag:'geo' and Affected:'Markets UP'.
// That fabricated a market signal out of nothing (e.g. a cricketer's innings
// got rendered as "Markets UP"). The LLM relevance pass below is the actual
// fix: anything that isn't genuinely relevant gets dropped before render,
// instead of being forced into a tag it doesn't deserve.
//
// Falls back to curated reference events if GNews quota is hit, and falls
// back to plain keyword classification (no forced defaults) if Groq is
// unavailable — never blocks or errors the response.

const GNEWS_KEY = process.env.GNEWS_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
// GNews free tier = 100 requests/day total. Each query below costs 1 request.
// Cache TTL raised from 20→60 min and topics merged into a single query each
// (was 3+2+2=7 calls per full refresh cycle, now 1+1+1=3) to stay well under
// quota even when Vercel cold-starts wipe the in-memory cache between visits.
const CACHE_TTL = 60 * 60 * 1000; // 60 min

// Separate cache per topic so War Intel / India+Tech tabs don't collide
// with the general feed's cache entry.
const cacheByTopic = {};

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

  // Affected commodities — empty array (not a fabricated default) when
  // nothing matches. This is the keyword fallback path used only when the
  // LLM relevance pass below is unavailable, so it must not invent signal.
  const affected = [];
  for (const [com, { keywords, dir }] of Object.entries(COMMODITY_MAP)) {
    if (keywords.some(k => text.match(new RegExp(k)))) {
      affected.push({ c: com.charAt(0).toUpperCase() + com.slice(1), d: dir });
    }
  }

  return { tag, sev, affected };
}

// Tags the front-end actually has CSS classes for (tag-war, tag-sanction,
// tag-supply, tag-trade, tag-geo in index.html) — 'geo' doubles as the
// general/economic catch-all so the LLM never has to invent an unstyled tag.
const VALID_TAGS = ['war', 'sanction', 'supply', 'trade', 'geo'];
const VALID_SEV = ['critical', 'high', 'moderate', 'low'];

// Sends the deduped headline batch to Groq for a relevance + classification
// pass. Returns a map of { [index]: result } on success, or null on any
// failure (no key, network error, timeout, malformed JSON) so the caller can
// fall back to plain keyword classify() without dropping anything.
async function classifyWithLLM(articles) {
  if (!GROQ_API_KEY || !articles.length) return null;

  const list = articles.map((a, i) =>
    `${i}. "${a.title}" — ${(a.description || '').slice(0, 160)}`
  ).join('\n');

  const prompt = `You are a news triage filter for GeoCMX, a geopolitical-risk and commodity-market intelligence terminal. Below is a numbered list of headlines pulled from a broad keyword search, so some are NOT actually relevant — e.g. sports, entertainment, or celebrity stories that happen to mention a country, company, or person also covered in market news (a cricketer scoring a fifty is NOT a market signal just because the article mentions "India").

For EACH numbered item, decide:
1. "relevant": true only if the headline carries genuine geopolitical, macroeconomic, market, trade, or commodity-supply signal. When in doubt, mark false.
2. "score": 0-100, how strong/market-moving the signal is (0 = irrelevant, 100 = major market-moving event).
3. "tag": one of war, sanction, supply, trade, geo (geo = general geopolitical/economic, use it when nothing else fits), or none if not relevant.
4. "severity": one of critical, high, moderate, low, or none if not relevant.
5. "affected": array of {"c": commodity or asset name, "d": "up" or "down"} for things genuinely affected (e.g. Crude, Gold, Wheat, Freight, Copper, INR, Markets). Empty array if nothing specific or not relevant.
6. "reason": one short sentence justifying the call.

Headlines:
${list}

Respond with strict JSON only, no prose, no markdown fences: {"results":[{"id":0,"relevant":true,"score":75,"tag":"war","severity":"high","affected":[{"c":"Crude","d":"up"}],"reason":"..."}, ...]} — exactly one entry per headline, "id" matching the headline number above.`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.results)) return null;

    const byId = {};
    for (const item of parsed.results) {
      if (item && typeof item.id === 'number') byId[item.id] = item;
    }
    return byId;
  } catch {
    return null;
  }
}

// Merges one article's LLM result (if present and well-formed) with the
// keyword classify() fallback. `llmById` is the map from classifyWithLLM(),
// or null if that batch failed outright.
function resolveClassification(article, llmById, index) {
  const r = llmById ? llmById[index] : null;

  if (r && typeof r.relevant === 'boolean') {
    const tag = VALID_TAGS.includes(r.tag) ? r.tag : 'geo';
    const sev = VALID_SEV.includes(r.severity) ? r.severity : 'low';
    const affected = Array.isArray(r.affected)
      ? r.affected
          .filter(a => a && a.c && (a.d === 'up' || a.d === 'down'))
          .map(a => ({ c: String(a.c), d: a.d }))
      : [];
    const score = typeof r.score === 'number' ? r.score : (r.relevant ? 60 : 0);
    return { tag, sev, affected, relevant: r.relevant && score >= 35 };
  }

  // No usable LLM entry for this article. If the LLM batch otherwise
  // succeeded, this single item just failed to parse — better to keep it
  // (via keyword fallback) than silently drop it on a partial response.
  // If the whole batch failed (llmById === null), every article goes
  // through this same path, matching the old no-Groq behavior.
  const kw = classify(article.title, article.description || '');
  return { ...kw, relevant: true };
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60)  return mins + 'm ago';
  if (mins < 1440) return Math.floor(mins / 60) + 'h ago';
  return Math.floor(mins / 1440) + 'd ago';
}

function buildPrompt(title, sev, affected) {
  const comList = affected.length
    ? affected.map(a => a.c).join(', ')
    : 'no specific commodity — general market/geopolitical signal';
  return `Analyze the commodity and market impact of: "${title}". `
    + `Severity: ${sev.toUpperCase()}. Potentially affected: ${comList}. `
    + `For each commodity, state THEORY (UP/DOWN/NEUTRAL) vs ACTUAL price direction and explain the gap. `
    + `End with: RISK level, one-sentence MARKET IMPACT, and one WATCH indicator.`;
}

// GNews /search treats space-separated words as implicit AND — every word
// must appear in the article, which is why the old literal multi-word
// queries ("geopolitical war sanctions oil") returned almost nothing.
// Use explicit OR between keywords for broad recall instead.
// One merged query per topic (not 2-3) — each query is a separate GNews
// request and the free plan only allows 100/day total.
const TOPIC_QUERIES = {
  general: [
    'war OR conflict OR sanctions OR tariff OR ceasefire OR military OR missile OR oil OR opec OR crude OR brent OR hormuz OR shipping OR tanker OR india OR rbi OR rupee OR sensex OR nifty OR economy',
  ],
  war: [
    'war OR military OR missile OR strike OR ceasefire OR invasion OR troops OR hormuz OR houthi OR iran OR israel OR ukraine OR russia OR gaza',
  ],
  india: [
    'india OR rupee OR rbi OR sensex OR nifty OR infosys OR tcs OR startup OR semiconductor OR ipo',
  ],
};

// Accepts the already-classified { article, cls } pairs built in handler()
// below — avoids re-running keyword classify() and losing the LLM result.
function toBriefCards(classifiedArticles) {
  return classifiedArticles.map(({ article: a, cls }) => {
    const comList = cls.affected.map(x => x.c).join(', ');
    return {
      cat: cls.tag,
      headline: a.title,
      body: a.description || '',
      src: (a.source?.name || 'News') + ' · ' + timeAgo(a.publishedAt),
      impact: comList
        ? 'Affected: ' + comList + ' (' + cls.sev.toUpperCase() + ' severity)'
        : 'General market/geopolitical signal (' + cls.sev.toUpperCase() + ' severity)',
      prompt: buildPrompt(a.title, cls.sev, cls.affected),
      url: a.url,
    };
  });
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

  const topic = (req.query && req.query.topic) || 'general';
  const queries = TOPIC_QUERIES[topic] || TOPIC_QUERIES.general;
  const cache = cacheByTopic[topic] || { data: null, ts: 0 };

  // Serve cache if fresh
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return res.status(200).json(cache.data);
  }

  if (!GNEWS_KEY) {
    const payload = { news: REFERENCE_EVENTS, items: [], lastFetched: new Date().toISOString(), source: 'reference' };
    return res.status(200).json(payload);
  }

  try {
    const allArticles = [];

    for (const q of queries) {
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(q)}&lang=en&max=10&apikey=${GNEWS_KEY}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'GeoIntelTerminal/2.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      if (d.articles) allArticles.push(...d.articles);
    }

    if (!allArticles.length) throw new Error('no articles');

    // Deduplicate by title
    const seen = new Set();
    const dedup = allArticles.filter(a => {
      const key = a.title.slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // LLM relevance + classification pass over the whole deduped batch in
    // one request. Returns null if Groq is unavailable/fails — in that case
    // every article falls back to keyword classify() and nothing is dropped
    // (old behavior, minus the fabricated "Markets UP" default).
    const llmById = await classifyWithLLM(dedup);

    const classified = dedup.map((a, i) => ({
      article: a,
      cls: resolveClassification(a, llmById, i),
    }));

    // Only filter out irrelevant articles when the LLM pass actually ran —
    // if it failed outright, keep everything rather than silently emptying
    // the feed.
    let relevant = llmById ? classified.filter(x => x.cls.relevant) : classified;

    // Edge case: LLM ran and marked everything irrelevant (e.g. a quiet news
    // day where the broad query only surfaced noise). Showing a blank
    // terminal would look broken, so fall back to keeping the unfiltered
    // batch rather than an empty feed.
    if (llmById && !relevant.length && classified.length) relevant = classified;

    const news = relevant.slice(0, 16).map(({ article: a, cls }) => ({
      title: a.title,
      tag: cls.tag,
      src: a.source?.name || 'News',
      age: timeAgo(a.publishedAt),
      sev: cls.sev,
      url: a.url,
      affected: cls.affected,
      prompt: buildPrompt(a.title, cls.sev, cls.affected),
    }));

    const items = toBriefCards(relevant.slice(0, 12));

    const payload = { news, items, lastFetched: new Date().toISOString(), source: 'live' };
    cacheByTopic[topic] = { data: payload, ts: Date.now() };
    return res.status(200).json(payload);

  } catch (e) {
    const payload = { news: REFERENCE_EVENTS, items: [], lastFetched: new Date().toISOString(), source: 'reference' };
    return res.status(200).json(payload);
  }
}
