// Vercel serverless function: /api/scan
// Scans cards through eBay's Browse API, computes EV, returns ranked results.
//
// Endpoints:
//   GET  /api/scan           → scan the default card database
//   POST /api/scan           → scan a custom card (body: { query, name? })
//
// Auth: uses EBAY_CLIENT_ID and EBAY_CLIENT_SECRET from environment variables.

import { CARD_DATABASE } from "./cards.js";

// ===== eBay API helpers =====

const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

// Cache OAuth token across function invocations (Vercel keeps process warm)
let cachedToken = null;
let tokenExpiresAt = 0;

async function getEbayToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing eBay credentials in environment variables");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const resp = await fetch(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`eBay OAuth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

async function searchEbay(query, token) {
  const params = new URLSearchParams({
    q: query,
    limit: "50",
    category_ids: "212",
    filter: "buyingOptions:{FIXED_PRICE},itemLocationCountry:US",
  });

  const resp = await fetch(`${EBAY_BROWSE_URL}?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`eBay search failed for "${query}" (${resp.status}): ${text.slice(0, 200)}`);
  }

  return await resp.json();
}

function extractPrices(searchResult, mustInclude, mustExclude) {
  const items = searchResult.itemSummaries || [];
  const prices = [];
  for (const item of items) {
    const title = (item.title || "").toLowerCase();
    if (mustInclude.some((tok) => !title.includes(tok.toLowerCase()))) continue;
    if (mustExclude.some((tok) => title.includes(tok.toLowerCase()))) continue;
    const priceObj = item.price || {};
    if (priceObj.currency !== "USD") continue;
    const p = parseFloat(priceObj.value);
    if (!isNaN(p) && p > 0) prices.push(p);
  }
  return prices;
}

function stripOutliers(prices, multiplier = 3.0) {
  if (prices.length < 3) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return prices;
  return prices.filter((p) => p >= median / multiplier && p <= median * multiplier);
}

function priceStats(prices) {
  if (!prices.length) return { median: null, n: 0, lowConfidence: true };
  const cleaned = stripOutliers(prices);
  if (!cleaned.length) return { median: null, n: 0, lowConfidence: true };
  const sorted = [...cleaned].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    median: Math.round(median * 100) / 100,
    n: cleaned.length,
    lowConfidence: cleaned.length < 5,
  };
}

function computeEV(card, prices) {
  const probs = { psa10: 18, psa9: 55, psa8: 22, psa7orLower: 5 };

  const psa8Price = (prices.psa9.median || 0) * 0.55;
  const psaLowerPrice = Math.max((prices.raw.median || 0) * 0.6, 1);

  const gradingCost = 32.99;
  const shippingCost = 15;
  const sellFeePct = 13;
  const salesTaxPct = 8;
  const buyShippingCost = 5;

  const rawCost = prices.raw.median || 0;
  const salesTax = rawCost * salesTaxPct / 100;
  const totalCost = rawCost + salesTax + buyShippingCost + gradingCost + shippingCost;

  const feeMultiplier = 1 - sellFeePct / 100;
  const REALISM_DISCOUNT = 0.82;

  const grades = [
    { name: "psa10", prob: probs.psa10 / 100, price: (prices.psa10.median || 0) * REALISM_DISCOUNT },
    { name: "psa9",  prob: probs.psa9  / 100, price: (prices.psa9.median  || 0) * REALISM_DISCOUNT },
    { name: "psa8",  prob: probs.psa8  / 100, price: psa8Price * REALISM_DISCOUNT },
    { name: "lower", prob: probs.psa7orLower / 100, price: psaLowerPrice * REALISM_DISCOUNT },
  ];

  const outcomes = grades.map((g) => {
    const netPrice = g.price * feeMultiplier;
    const profit = netPrice - totalCost;
    return { ...g, profit };
  });

  const ev = outcomes.reduce((s, o) => s + o.prob * o.profit, 0);
  const variance = outcomes.reduce((s, o) => s + o.prob * Math.pow(o.profit - ev, 2), 0);
  const stdDev = Math.sqrt(variance);
  const probLoss = outcomes.filter((o) => o.profit < 0).reduce((s, o) => s + o.prob, 0);
  const sharpe = stdDev > 0 ? ev / stdDev : 0;
  const roi = totalCost > 0 ? (ev / totalCost) * 100 : 0;

  let verdict;
  if (ev <= 0) verdict = "AVOID";
  else if (sharpe < 0.3 || probLoss > 0.6) verdict = "HIGH_RISK";
  else if (sharpe < 0.7) verdict = "MARGINAL";
  else if (sharpe < 1.5) verdict = "FAVORABLE";
  else verdict = "STRONG_BUY";

  return {
    ev: Math.round(ev * 100) / 100,
    roi: Math.round(roi * 100) / 100,
    sharpe: Math.round(sharpe * 1000) / 1000,
    probLoss: Math.round(probLoss * 10000) / 10000,
    totalCost: Math.round(totalCost * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    verdict,
  };
}

async function scanCard(card, token) {
  const commonExclude = ["lot", "reprint", "custom", "proxy", "digital", "nft", "case break", "break"];

  try {
    const rawResult = await searchEbay(card.query, token);
    const psa9Result = await searchEbay(`${card.query} PSA 9`, token);
    const psa10Result = await searchEbay(`${card.query} PSA 10`, token);

    const rawPrices = extractPrices(
      rawResult, [],
      [...commonExclude, "psa", "bgs", "sgc", "cgc", "graded", "slab"]
    );
    const psa9Prices = extractPrices(
      psa9Result, ["psa 9"],
      [...commonExclude, "psa 10", "bgs 9.5", "bgs 10"]
    );
    const psa10Prices = extractPrices(
      psa10Result, ["psa 10"],
      [...commonExclude, "psa 9 ", "lot of"]
    );

    const prices = {
      raw: priceStats(rawPrices),
      psa9: priceStats(psa9Prices),
      psa10: priceStats(psa10Prices),
    };

    if (!prices.raw.median || !prices.psa9.median || !prices.psa10.median) {
      const missing = [];
      if (!prices.raw.median) missing.push("raw");
      if (!prices.psa9.median) missing.push("PSA 9");
      if (!prices.psa10.median) missing.push("PSA 10");
      return {
        ...card,
        status: "incomplete",
        note: `missing comps: ${missing.join(", ")}`,
        prices,
      };
    }

    const ev = computeEV(card, prices);

    return {
      ...card,
      status: "ok",
      prices,
      ...ev,
    };
  } catch (err) {
    return {
      ...card,
      status: "error",
      note: err.message,
    };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const token = await getEbayToken();

    if (req.method === "POST") {
      const body = req.body || {};
      if (!body.query) {
        return res.status(400).json({ error: "query is required" });
      }
      const customCard = {
        id: `custom-${Date.now()}`,
        query: body.query,
        sport: body.sport || "Custom",
        year: body.year || "",
        set: body.set || "",
        player: body.player || body.name || body.query,
        cardNumber: body.cardNumber || "",
      };
      const result = await scanCard(customCard, token);
      return res.status(200).json({ result });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? parseInt(limitParam) : CARD_DATABASE.length;
    const sport = url.searchParams.get("sport");

    let cards = CARD_DATABASE;
    if (sport) {
      cards = cards.filter((c) => c.sport.toLowerCase() === sport.toLowerCase());
    }
    cards = cards.slice(0, limit);

    const BATCH_SIZE = 5;
    const results = [];
    for (let i = 0; i < cards.length; i += BATCH_SIZE) {
      const batch = cards.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((c) => scanCard(c, token)));
      results.push(...batchResults);
    }

    return res.status(200).json({
      scannedAt: new Date().toISOString(),
      total: results.length,
      results,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Scanner error",
      hint: "Check that EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are set in Vercel environment variables.",
    });
  }
}
