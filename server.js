// server.js (Improved relevance + safer Top 3)
// - Default "Any": Google Shopping only
// - store=eBay: eBay only (NEW only by default)
// - Adds relevance scoring (match score -> then price)
// - Adds category-aware junk filtering (footwear/clothing)
// - Keeps store name filtering for Google sources
//
// NOTE: Replace entire file with this. Keep your Render env vars:
// SERPAPI_KEY, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

// --------------------
// eBay OAuth token cache (App token)
// --------------------
let ebayTokenCache = { token: null, expiresAt: 0 };

function base64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

async function getEbayAppToken() {
  const now = Date.now();
  if (ebayTokenCache.token && now < ebayTokenCache.expiresAt - 60_000) {
    return ebayTokenCache.token;
  }
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) return null;

  const url = "https://api.ebay.com/identity/v1/oauth2/token";
  const auth = `Basic ${base64(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)}`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: auth,
    },
    body,
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`eBay token error: ${r.status} ${text}`);
  }

  const data = await r.json();
  ebayTokenCache.token = data.access_token;
  ebayTokenCache.expiresAt = now + data.expires_in * 1000;
  return ebayTokenCache.token;
}

// --------------------
// Query intent + scoring
// --------------------
const STOPWORDS = new Set([
  "the","a","an","and","or","for","with","without","to","of","in","on","at","by",
  "new","brand","original","genuine","authentic",
  "size","uk","us","eu","mens","men","men's","womens","women","women's","kids","kid","child","children",
  "pack","set","bundle"
]);

function normalizeText(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuery(q) {
  const norm = normalizeText(q);
  const raw = norm.split(" ").filter(Boolean);
  // Keep numbers (like 95, 270, etc.) and important brand/model words
  const tokens = raw.filter(t => t.length >= 2 && !STOPWORDS.has(t));
  // De-duplicate
  return Array.from(new Set(tokens));
}

function looksLikeFootwear(q) {
  const s = normalizeText(q);
  const keys = ["shoe","shoes","trainer","trainers","sneaker","sneakers","boot","boots","football","cleats"];
  return keys.some(k => s.includes(k)) || /\bair\s?max\b/.test(s);
}

function looksLikeClothing(q) {
  const s = normalizeText(q);
  const keys = ["hoodie","tshirt","t-shirt","tee","shirt","polo","jacket","coat","jumper","sweater","tracksuit","jeans","trousers","pants","shorts","leggings","dress","skirt","top"];
  return keys.some(k => s.includes(k));
}

function getIntent(q) {
  if (looksLikeFootwear(q)) return "footwear";
  if (looksLikeClothing(q)) return "clothing";
  return "general";
}

// Category-aware negative keywords (prevents cheap accessories hijacking Top 3)
const NEGATIVE_COMMON = [
  "phone case","case for","cover","screen protector","tempered glass","camera lens",
  "sticker","skin","strap","lanyard","keychain","key ring","holder","stand"
];

const NEGATIVE_FOOTWEAR = [
  "laces","lace","insole","insoles","shoe cleaner","cleaner","protector spray","spray",
  "sock","socks","shoe bag","bag","replacement","repair","kit","insert"
];

const NEGATIVE_CLOTHING = [
  "hanger","washing","laundry","detergent","patch","iron on","button","zipper","zip","thread"
];

function containsNegative(title, list) {
  const t = normalizeText(title);
  return list.some(neg => t.includes(neg));
}

function passesNegativeFilter(item, intent) {
  const title = item.title || "";
  if (containsNegative(title, NEGATIVE_COMMON)) return false;
  if (intent === "footwear" && containsNegative(title, NEGATIVE_FOOTWEAR)) return false;
  if (intent === "clothing" && containsNegative(title, NEGATIVE_CLOTHING)) return false;
  return true;
}

// Relevance scoring: score by query token matches + phrase bonuses
function scoreItem(itemTitle, query, tokens) {
  const title = normalizeText(itemTitle);
  if (!title) return 0;

  let score = 0;

  // Token matches
  for (const tok of tokens) {
    if (title.includes(tok)) score += 2;
  }

  // Phrase bonuses for common patterns
  const qNorm = normalizeText(query);

  // Bonus if title contains "air max" when query includes it
  if (qNorm.includes("air max") && title.includes("air max")) score += 6;

  // Bonus if query contains a number model (e.g. 95, 270) and title contains it
  const nums = qNorm.match(/\b\d{2,4}\b/g) || [];
  for (const n of nums) {
    if (title.includes(n)) score += 4;
  }

  // Penalty if title contains "women" or "kids" when query seems men-focused (light touch)
  if (qNorm.includes("men") || qNorm.includes("mens") || qNorm.includes("men's")) {
    if (title.includes("women") || title.includes("womens") || title.includes("kid") || title.includes("kids")) score -= 4;
  }

  // Slight penalty for suspiciously generic titles
  if (title.length < 12) score -= 2;

  return score;
}

// Rank: score desc, then price asc
function rankAndPickTop3(items, query) {
  const tokens = tokenizeQuery(query);
  return items
    .map(it => ({
      ...it,
      _score: scoreItem(it.title, query, tokens)
    }))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return a.price - b.price;
    })
    .slice(0, 3)
    .map(({ _score, ...rest }) => rest);
}

// --------------------
// SerpApi: Google Shopping
// --------------------
async function fetchGoogleShopping(q, country) {
  if (!SERPAPI_KEY) return [];

  const gl = country === "GB" ? "gb" : "us";
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", q);
  url.searchParams.set("gl", gl);
  url.searchParams.set("hl", "en");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const r = await fetch(url);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`SerpApi error: ${r.status} ${text}`);
  }

  const data = await r.json();

  return (data.shopping_results || [])
    .map((it) => {
      const price = Number(it.extracted_price);
      if (!Number.isFinite(price)) return null;

      // Prefer a "product_link" if present, otherwise fallback.
      const link = it.product_link || it.link || "";

      return {
        title: it.title || "Item",
        store: it.source || "Google Shopping",
        price,
        currency: "GBP",
        url: link,
        source: "google",
      };
    })
    .filter(Boolean)
    .filter((x) => x.url);
}

// --------------------
// eBay Browse API (ONLY used when store=eBay)
// Default: NEW items only unless condition=used
// --------------------
async function fetchEbay(q, country, condition = "new") {
  const token = await getEbayAppToken();
  if (!token) return [];

  const marketplaceId = country === "GB" ? "EBAY_GB" : "EBAY_US";

  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "40");
  url.searchParams.set("sort", "price");

  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    },
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`eBay browse error: ${r.status} ${text}`);
  }

  const data = await r.json();

  let items = (data.itemSummaries || [])
    .map((it) => {
      const priceVal = Number(it.price?.value);
      if (!Number.isFinite(priceVal)) return null;

      const link = it.itemAffiliateWebUrl || it.itemWebUrl || "";
      return {
        title: it.title || "Item",
        store: "eBay",
        price: priceVal,
        currency: it.price?.currency || "GBP",
        url: link,
        source: "ebay",
        condition: it.condition || "",
      };
    })
    .filter(Boolean)
    .filter((x) => x.url);

  const cond = (condition || "new").toLowerCase();
  if (cond === "new") {
    items = items.filter((x) => (x.condition || "").toLowerCase() === "new");
  } else if (cond === "used") {
    items = items.filter((x) => (x.condition || "").toLowerCase().includes("used"));
  }

  return items;
}

// --------------------
// Routes
// --------------------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

/**
 * GET /search?q=...&country=GB&store=Any|Nike|JD|...|eBay&condition=new|used
 *
 * Improved behavior:
 * - Default "Any": Google Shopping only, ranked by relevance then price.
 * - store=eBay: eBay only, ranked by relevance then price, NEW only by default.
 * - store=Other: filters Google results by store name then ranks.
 * - Category-aware negative filters reduce irrelevant accessories.
 */
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const country = (req.query.country || "GB").toString().trim().toUpperCase();
    const store = (req.query.store || "Any").toString().trim();
    const condition = (req.query.condition || "new").toString().trim(); // for eBay only

    if (!q) return res.status(400).json({ error: "Missing q" });

    const intent = getIntent(q);

    // eBay only (opt-in)
    if (store.toLowerCase() === "ebay") {
      const ebayItemsRaw = await fetchEbay(q, country, condition).catch(() => []);
      const ebayItems = ebayItemsRaw.filter(it => passesNegativeFilter(it, intent));
      const top = rankAndPickTop3(ebayItems, q);
      return res.json({ query: q, store, condition, intent, results: top });
    }

    // Google Shopping only by default
    let googleItems = await fetchGoogleShopping(q, country).catch(() => []);

    // Category-aware junk filtering
    googleItems = googleItems.filter(it => passesNegativeFilter(it, intent));

    // Optional store-name filtering for Google results
    let filtered = googleItems;
    if (store && store.toLowerCase() !== "any") {
      const s = store.toLowerCase();
      filtered = filtered.filter((x) => (x.store || "").toLowerCase().includes(s));
    }

    // Rank by relevance then price
    const top3 = rankAndPickTop3(filtered, q);

    res.json({ query: q, store, intent, results: top3 });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`FNDiT backend listening on ${PORT}`);
});
