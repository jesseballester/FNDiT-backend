import express from "express";
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;

// If you later re-enable eBay, keep these env vars.
// (This file currently keeps eBay disabled in search/runSearch by default.)
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

const CHECK_SECRET = process.env.CHECK_SECRET || "";

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
// Helpers
// --------------------
function normalizeQueryKey(q) {
  return (q || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeCondition(c) {
  const v = (c || "new").toString().trim().toLowerCase();
  if (v === "any") return "any";
  if (v === "used") return "used";
  return "new"; // default
}

// --------------------
// DB init + migrations
// --------------------
async function initDb() {
  // Base tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_searches (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      query TEXT NOT NULL,
      query_key TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'new',
      last_price NUMERIC,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Add constraint if it doesn't exist (device_id + query_key + condition unique)
  // We create a named unique index safely.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'tracked_searches_device_query_condition_uidx'
      ) THEN
        CREATE UNIQUE INDEX tracked_searches_device_query_condition_uidx
        ON tracked_searches (device_id, query_key, condition);
      END IF;
    END$$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_drops (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      query_key TEXT NOT NULL,
      query TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT 'new',
      old_price NUMERIC NOT NULL,
      new_price NUMERIC NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("✅ DB ready: tracked_searches + price_drops");
}

// --------------------
// Health
// --------------------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

// --------------------
// TRACKING (Persistent) - condition-aware (default NEW)
// --------------------
app.post("/track", async (req, res) => {
  try {
    const { deviceId, query, condition } = req.body || {};
    if (!deviceId || !query) {
      return res.status(400).json({ error: "Missing deviceId or query" });
    }

    const queryKey = normalizeQueryKey(query);
    const cond = normalizeCondition(condition); // default new

    await pool.query(
      `
      INSERT INTO tracked_searches (device_id, query, query_key, condition)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (device_id, query_key, condition)
      DO UPDATE SET query = EXCLUDED.query
      `,
      [deviceId, query, queryKey, cond]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Track failed", detail: String(e) });
  }
});

app.post("/untrack", async (req, res) => {
  try {
    const { deviceId, query, condition } = req.body || {};
    if (!deviceId || !query) {
      return res.status(400).json({ error: "Missing deviceId or query" });
    }

    const queryKey = normalizeQueryKey(query);
    const cond = normalizeCondition(condition);

    await pool.query(
      `DELETE FROM tracked_searches WHERE device_id = $1 AND query_key = $2 AND condition = $3`,
      [deviceId, queryKey, cond]
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
      SELECT query, condition, last_price, last_seen_at, created_at
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

app.get("/drops", async (req, res) => {
  try {
    const deviceId = (req.query.deviceId || "").toString().trim();
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });

    const r = await pool.query(
      `
      SELECT query, condition, old_price, new_price, currency, detected_at
      FROM price_drops
      WHERE device_id = $1
      ORDER BY detected_at DESC
      LIMIT 50
      `,
      [deviceId]
    );

    res.json({ ok: true, drops: r.rows });
  } catch (e) {
    res.status(500).json({ error: "Drops fetch failed", detail: String(e) });
  }
});

// --------------------
// Search: Improved relevance + safer Top 3 + condition filter
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

// Condition inference for Google Shopping results
function isUsedLike(item) {
  const s = `${item.secondHand || ""} ${item.title || ""}`.toLowerCase();
  return (
    s.includes("used") ||
    s.includes("pre-owned") ||
    s.includes("preowned") ||
    s.includes("second hand") ||
    s.includes("secondhand") ||
    s.includes("refurb") ||
    s.includes("refurbished") ||
    s.includes("renewed") ||
    s.includes("open box") ||
    s.includes("open-box")
  );
}

function filterByCondition(items, condition) {
  const cond = normalizeCondition(condition);
  if (cond === "any") return items;

  if (cond === "used") {
    return items.filter(isUsedLike);
  }

  // Default: new -> exclude used-like
  return items.filter((x) => !isUsedLike(x));
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
        secondHand: it.second_hand_condition || "", // helps with new/used filtering
        source: "google",
      };
    })
    .filter(Boolean)
    .filter((x) => x.url);
}

/**
 * Unified search function used by /search and the price checker.
 * condition defaults to NEW.
 */
async function runSearch({ q, country = "GB", store = "Any", condition = "new" }) {
  const intent = getIntent(q);

  // eBay is intentionally disabled here (you said you don’t like used items dominating).
  // Keep store=eBay from breaking the app by returning empty.
  if ((store || "").toLowerCase() === "ebay") {
    return { intent, results: [] };
  }

  let items = await fetchGoogleShopping(q, country);

  // negative filters first
  items = items.filter((it) => passesNegativeFilter(it, intent));

  // condition filter (default new)
  items = filterByCondition(items, condition);

  // optional store-name filter (Nike/JD/etc)
  let filtered = items;
  if (store && store.toLowerCase() !== "any") {
    const s = store.toLowerCase();
    filtered = filtered.filter((x) => (x.store || "").toLowerCase().includes(s));
  }

  const top3 = rankAndPickTop3(filtered, q);
  return { intent, results: top3 };
}

/**
 * GET /search?q=...&country=GB&store=Any&condition=new|used|any
 * Default condition is NEW.
 */
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const country = (req.query.country || "GB").toString().trim().toUpperCase();
    const store = (req.query.store || "Any").toString().trim();
    const condition = normalizeCondition(req.query.condition || "new"); // default new

    if (!q) return res.status(400).json({ error: "Missing q" });

    const { intent, results } = await runSearch({ q, country, store, condition });
    res.json({ query: q, store, condition, intent, results });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

// --------------------
// PRICE CHECKER (Manual trigger) - condition-aware
// --------------------
app.get("/run-price-check", async (req, res) => {
  try {
    const secret = (req.query.secret || "").toString();
    if (!CHECK_SECRET || secret !== CHECK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const r = await pool.query(`
      SELECT device_id, query, query_key, condition, last_price
      FROM tracked_searches
      ORDER BY created_at ASC
    `);

    let checked = 0;
    let updated = 0;
    let drops = 0;

    for (const row of r.rows) {
      const deviceId = row.device_id;
      const query = row.query;
      const queryKey = row.query_key;
      const condition = normalizeCondition(row.condition || "new");
      const oldPrice = row.last_price === null ? null : Number(row.last_price);

      // Run search using the stored condition
      const { results } = await runSearch({
        q: query,
        country: "GB",
        store: "Any",
        condition,
      });

      const cheapest = results?.length ? results[0] : null;
      const newPrice = cheapest ? Number(cheapest.price) : null;

      checked += 1;

      // Update last_seen_at always
      if (newPrice === null || !Number.isFinite(newPrice)) {
        await pool.query(
          `UPDATE tracked_searches
           SET last_seen_at = NOW()
           WHERE device_id=$1 AND query_key=$2 AND condition=$3`,
          [deviceId, queryKey, condition]
        );
        continue;
      }

      // First time price set
      if (oldPrice === null || !Number.isFinite(oldPrice)) {
        await pool.query(
          `UPDATE tracked_searches
           SET last_price=$1, last_seen_at=NOW()
           WHERE device_id=$2 AND query_key=$3 AND condition=$4`,
          [newPrice, deviceId, queryKey, condition]
        );
        updated += 1;
        continue;
      }

      // Detect drop
      if (newPrice < oldPrice) {
        await pool.query(
          `INSERT INTO price_drops (device_id, query_key, query, condition, old_price, new_price, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [deviceId, queryKey, query, condition, oldPrice, newPrice, cheapest.currency || "GBP"]
        );
        drops += 1;
      }

      // Always update latest observed price
      await pool.query(
        `UPDATE tracked_searches
         SET last_price=$1, last_seen_at=NOW()
         WHERE device_id=$2 AND query_key=$3 AND condition=$4`,
        [newPrice, deviceId, queryKey, condition]
      );
      updated += 1;
    }

    res.json({ ok: true, checked, updated, drops });
  } catch (e) {
    res.status(500).json({ error: "Price check failed", detail: String(e) });
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
