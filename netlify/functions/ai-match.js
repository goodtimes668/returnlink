// netlify/functions/ai-match.js
// Calls Anthropic API to intelligently route a returned product to the best
// partner drop-off location based on partner specialty + product type.
//
// Required env var on Netlify:
//   ANTHROPIC_API_KEY  (set in Site settings → Environment variables)

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap, perfect for routing

const SYSTEM_PROMPT = `You are a returns logistics router for ReturnLink, a service that helps online sellers redirect customer returns to local partner businesses instead of shipping items back to the warehouse.

Given a product being returned and a list of partner drop-off locations with their specialties, recommend the best partner.

Routing logic:
- DRY CLEANERS handle garments, textiles, fabrics, linens, clothing, bedding well — they can professionally clean before resale
- THRIFT STORES handle resellable hardgoods well — housewares, decor, ceramics, books, kitchenware, accessories — they pay store credit + resell
- MAIL/SHIPPING STORES are the catch-all — electronics, fragile items, oversized items, or anything the other partners can't take

Always pick ONE partner. Estimate the credit-back the customer gets (in USD, between $1.50 and $8.00 — higher for items the partner can profitably resell, lower for items that just need to be returned to warehouse via the partner).

Respond ONLY with valid JSON in this exact shape:
{
  "partner_id": "P1",
  "reasoning": "one short customer-facing sentence explaining why this partner is best",
  "estimated_credit_back": 4.50
}

No prose, no markdown, no code fences. Just the JSON object.`;

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Missing ANTHROPIC_API_KEY env var');
    return json(500, { error: 'server_misconfigured', fallback: defaultFallback() });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'invalid_json' });
  }

  const { product, partners } = body;
  if (!product || !Array.isArray(partners) || partners.length === 0) {
    return json(400, { error: 'missing product or partners', received: Object.keys(body) });
  }

  const userMessage = `Product being returned: "${product}"

Available partner drop-off locations:
${partners.map(p => `- ${p.id}: ${p.name} (${p.specialty || 'general'}), ${p.distance || 'nearby'}`).join('\n')}

Recommend the best partner. Return JSON only.`;

  try {
    const apiRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Anthropic API error:', apiRes.status, errText);
      return json(502, {
        error: 'anthropic_api_error',
        status: apiRes.status,
        fallback: defaultFallback(product, partners)
      });
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text.trim() : '';

    // Strip code fences if model wraps anyway
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse model JSON:', raw);
      return json(200, { ...defaultFallback(product, partners), source: 'fallback_parse_fail' });
    }

    // Validate the partner_id exists in the input
    const valid = partners.find(p => p.id === parsed.partner_id);
    if (!valid) {
      console.warn('Model returned unknown partner_id:', parsed.partner_id);
      return json(200, { ...defaultFallback(product, partners), source: 'fallback_unknown_partner' });
    }

    return json(200, {
      partner_id: parsed.partner_id,
      reasoning: String(parsed.reasoning || '').slice(0, 200),
      estimated_credit_back: clampCredit(parsed.estimated_credit_back),
      source: 'ai'
    });

  } catch (err) {
    console.error('AI match unexpected error:', err);
    return json(500, {
      error: 'unexpected',
      message: err.message,
      fallback: defaultFallback(product, partners)
    });
  }
};

// ---------- helpers ----------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body)
  };
}

function clampCredit(n) {
  const v = Number(n);
  if (!isFinite(v)) return 3.00;
  return Math.max(1.50, Math.min(8.00, Math.round(v * 100) / 100));
}

// Heuristic fallback if AI fails — keeps the app working
function defaultFallback(product = '', partners = []) {
  const p = String(product).toLowerCase();
  let preferred = 'P3'; // mailbox catch-all

  if (/sweater|shirt|pants|jeans|jacket|dress|coat|linen|fabric|cloth|wool|cotton|silk/.test(p)) {
    preferred = 'P1'; // dry cleaner
  } else if (/mug|ceramic|book|plate|bowl|vase|decor|frame|candle|kitchen/.test(p)) {
    preferred = 'P2'; // thrift
  }

  const chosen = partners.find(x => x.id === preferred) || partners[0] || { id: 'P1' };

  return {
    partner_id: chosen.id,
    reasoning: 'Routed by product category — your nearest qualified partner.',
    estimated_credit_back: 3.50,
    source: 'fallback'
  };
}
