import express from "express";
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn("⚠️ Missing DATABASE_URL. Tracking endpoints will fail until it's set in Render.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

app.use(express.json());

// --------------------
// DB init
// --------------------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_searches (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      query TEXT NOT NULL,
      query_key TEXT NOT NULL,
      last_price NUMERIC,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (device_id, query_key)
    );
  `);
  console.log("✅ DB ready: tracked_searches");
}

function normalizeQueryKey(q) {
  return (q || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// --------------------
// Health
// --------------------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

// --------------------
// TRACKING (Persistent)
// --------------------
app.post("/track", async (req, res) => {
  try {
    const { deviceId, query } = req.body || {};
    if (!deviceId || !query) {
      return res.status(400).json({ error: "Missing deviceId or query" });
    }

    const queryKey = normalizeQueryKey(query);

    await pool.query(
      `
      INSERT INTO tracked_searches (device_id, query, query_key)
      VALUES ($1, $2, $3)
      ON CONFLICT (device_id, query_key)
      DO UPDATE SET query = EXCLUDED.query
      `,
      [deviceId, query, queryKey]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Track failed", detail: String(e) });
  }
});

app.post("/untrack", async (req, res) => {
  try {
    const { deviceId, query } = req.body || {};
    if (!deviceId || !query) {
      return res.status(400).json({ error: "Missing deviceId or query" });
    }

    const queryKey = normalizeQueryKey(query);

    await pool.query(
      `DELETE FROM tracked_searches WHERE device_id = $1 AND query_key = $2`,
      [deviceId, queryKey]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Untrack failed", detail: String(e) });
  }
});

app.get("/tracked", async (req, res) => {
  try {
    const deviceId = (req.query.deviceId || "").toString().trim();
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

    const r = await pool.query(
      `
      SELECT query, last_price, last_seen_at, created_at
      FROM tracked_searches
      WHERE device_id = $1
      ORDER BY created_at DESC
      `,
      [deviceId]
    );

    res.json({ ok: true, tracked: r.rows });
  } catch (e) {
    res.status(500).json({ error: "Tracked fetch failed", detail: String(e) });
  }
});

// --------------------
// Search: Improved relevance + safer Top 3
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
  const tokens = raw.filter(t => t.length >= 2 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

function looksLikeFootwear(q) {
  const s = normalizeText(q);
  const keys = ["shoe","shoes","trainer","trainers","sneaker","sneakers","boot","boots","football","cleats","air max","airmax"];
  return keys.some(k => s.includes(k));
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

function scoreItem(itemTitle, query, tokens) {
  const title = normalizeText(itemTitle);
  if (!title) return 0;

  let score = 0;
  for (const tok of tokens) {
    if (title.includes(tok)) score += 2;
  }

  const qNorm = normalizeText(query);

  if ((qNorm.includes("air max") || qNorm.includes("airmax")) && (title.includes("air max") || title.includes("airmax"))) {
    score += 6;
  }

  const nums = qNorm.match(/\b\d{2,4}\b/g) || [];
  for (const n of nums) {
    if (title.includes(n)) score += 4;
  }

  if (qNorm.includes("men") || qNorm.includes("mens") || qNorm.includes("men's")) {
    if (title.includes("women") || title.includes("womens") || title.includes("kid") || title.includes("kids")) score -= 4;
  }

  if (title.length < 12) score -= 2;

  return score;
}

function rankAndPickTop3(items, query) {
  const tokens = tokenizeQuery(query);
  return items
    .map(it => ({ ...it, _score: scoreItem(it.title, query, tokens) }))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return a.price - b.price;
    })
    .slice(0, 3)
    .map(({ _score, ...rest }) => rest);
}

// SerpApi: Google Shopping
async function fetchGoogleShopping(q, country) {
  if (!SERPAPI_KEY) throw new Error("Missing SERPAPI_KEY");

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

// eBay token cache + helpers
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
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: auth },
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

/**
 * GET /search?q=...&country=GB&store=Any|Nike|...|eBay&condition=new|used
 */
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const country = (req.query.country || "GB").toString().trim().toUpperCase();
    const store = (req.query.store || "Any").toString().trim();
    const condition = (req.query.condition || "new").toString().trim();

    if (!q) return res.status(400).json({ error: "Missing q" });

    const intent = getIntent(q);

    // eBay only (opt-in)
    if (store.toLowerCase() === "ebay") {
      const ebayItemsRaw = await fetchEbay(q, country, condition).catch(() => []);
      const ebayItems = ebayItemsRaw.filter(it => passesNegativeFilter(it, intent));
      const top = rankAndPickTop3(ebayItems, q);
      return res.json({ query: q, store, condition, intent, results: top });
    }

    // Google Shopping
    let googleItems = await fetchGoogleShopping(q, country);
    googleItems = googleItems.filter(it => passesNegativeFilter(it, intent));

    // Optional store-name filtering
    let filtered = googleItems;
    if (store && store.toLowerCase() !== "any") {
      const s = store.toLowerCase();
      filtered = filtered.filter((x) => (x.store || "").toLowerCase().includes(s));
    }

    const top3 = rankAndPickTop3(filtered, q);
    res.json({ query: q, store, intent, results: top3 });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

// --------------------
// Start
// --------------------
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`FNDiT backend listening on ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  });
