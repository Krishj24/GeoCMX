// /api/analyze.js  —  Vercel serverless function
// Proxies AI-analysis requests to Groq's LLaMA 3.3 model so the API key
// never has to live in client-side code (index.html).
//
// Setup: in the Vercel dashboard, Project Settings → Environment Variables,
// add GROQ_API_KEY (get a free key at console.groq.com). Redeploy after adding.

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!GROQ_API_KEY) {
    return res.status(200).json({ error: 'no_key' });
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_API_KEY
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.3
      })
    });

    if (!r.ok) {
      return res.status(200).json({ error: 'groq_error' });
    }

    const data = await r.json();
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) return res.status(200).json({ error: 'empty_response' });

    return res.status(200).json({ text });
  } catch (e) {
    return res.status(200).json({ error: 'request_failed' });
  }
}
