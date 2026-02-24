import express from "express";
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const CHECK_SECRET = process.env.CHECK_SECRET || "";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

app.use(express.json());

// =====================
// Utils
// =====================
function normalizeQueryKey(q) {
  return (q || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCondition(c) {
  const v = (c || "new").toString().trim().toLowerCase();
  if (v === "any") return "any";
  if (v === "used") return "used";
  return "new";
}

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function normText(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

// =====================
// DB init + migrations
// =====================
async function initDb() {
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

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tracked_searches_device_query_condition_uidx
    ON tracked_searches (device_id, query_key, condition);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_drops (
      id BIGSERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      query_key TEXT NOT NULL,
      query TEXT NOT NULL,
      old_price NUMERIC NOT NULL,
      new_price NUMERIC NOT NULL,
      currency TEXT NOT NULL DEFAULT 'GBP',
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ✅ Migration for older DBs
  await pool.query(`
    ALTER TABLE price_drops
    ADD COLUMN IF NOT EXISTS condition TEXT NOT NULL DEFAULT 'new';
  `);

  console.log("✅ Database ready");
}

// =====================
// Health
// =====================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

// =====================
// Track / Untrack / Tracked / Drops
// =====================
app.post("/track", async (req, res) => {
  try {
    const { deviceId, query, condition } = req.body || {};
    if (!deviceId || !query) {
      return res.status(400).json({ error: "Missing deviceId or query" });
    }

    const queryKey = normalizeQueryKey(query);
    const cond = normalizeCondition(condition);

    await pool.query(
      `
      INSERT INTO tracked_searches (device_id, query, query_key, condition)
      VALUES ($1,$2,$3,$4)
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
      `DELETE FROM tracked_searches WHERE device_id=$1 AND query_key=$2 AND condition=$3`,
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
      WHERE device_id=$1
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
      WHERE device_id=$1
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

// =====================
// Exact-match accuracy layer
// =====================

// Brand dictionary (expanded with LEGO)
const BRAND_ALIASES = [
  { key: "nike", variants: ["nike"] },
  { key: "adidas", variants: ["adidas"] },
  { key: "puma", variants: ["puma"] },
  { key: "new balance", variants: ["new balance", "newbalance", "nb"] },
  { key: "asics", variants: ["asics"] },
  { key: "reebok", variants: ["reebok"] },
  { key: "jordan", variants: ["jordan", "air jordan"] },
  { key: "converse", variants: ["converse"] },
  { key: "vans", variants: ["vans"] },
  { key: "the north face", variants: ["the north face", "north face", "tnf"] },
  { key: "lego", variants: ["lego"] }, // ✅ added
];

// Aggressive accessory blocklist
const ACCESSORY_BLOCKLIST = [
  // universal junk
  "phone case",
  "case for",
  "iphone case",
  "samsung case",
  "cover",
  "screen protector",
  "tempered glass",
  "sticker",
  "skin",
  "wrap",
  "grip",
  "holder",
  "stand",
  "mount",
  "keychain",
  "key ring",
  "lanyard",
  // footwear accessories
  "laces",
  "lace",
  "insole",
  "insoles",
  "shoe cleaner",
  "cleaner",
  "protector spray",
  "spray",
  "shoe care",
  "kit",
  "sock",
  "socks",
  "shoe bag",
  "replacement",
  "repair",
  "insert",
  // clothing accessories
  "hanger",
  "patch",
  "iron on",
  "iron-on",
  "button",
  "zipper",
  "zip",
  "thread",
];

// Kids/generalized terms (boys/girls/infant/etc.)
const KIDS_TERMS = [
  "kid",
  "kids",
  "child",
  "children",
  "boy",
  "boys",
  "girl",
  "girls",
  "infant",
  "newborn",
  "toddler",
  "baby",
  "babies",
  "youth",
  "junior",
  "jr",
  "school",
  "schoolwear",
  "school wear",
];

const MEN_TERMS = ["men", "mens", "man's", "male"];
const WOMEN_TERMS = ["women", "womens", "woman", "female", "ladies", "lady"];

function containsAny(text, phrases) {
  const t = normText(text);
  return phrases.some((p) => t.includes(normText(p)));
}

function detectBrands(q) {
  const t = normText(q);
  const found = [];
  for (const b of BRAND_ALIASES) {
    if (b.variants.some((v) => t.includes(normText(v)))) found.push(b.key);
  }
  return uniq(found);
}

// ✅ Updated: include 5–6 digit IDs (LEGO set numbers like 75331)
function extractModelNumbers(q) {
  const t = normText(q);
  const nums = t.match(/\b\d{2,6}\b/g) || [];
  return uniq(nums);
}

function detectGenderIntent(q) {
  const t = normText(q);

  const hasKids = KIDS_TERMS.some((k) => t.includes(k));
  const hasMen = MEN_TERMS.some((k) => t.includes(k));
  const hasWomen = WOMEN_TERMS.some((k) => t.includes(k));

  if (hasMen) return "men";
  if (hasWomen) return "women";
  if (hasKids) return "kids";
  return "any";
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "without",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "new",
  "brand",
  "original",
  "genuine",
  "authentic",
  "size",
  "uk",
  "us",
  "eu",
  "pack",
  "set",
  "bundle",
]);

function tokenize(q) {
  const t = normText(q);
  return uniq(
    t
      .split(" ")
      .filter(Boolean)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
  );
}

function confidenceScore(itemTitle, itemStore, qTokens, qBrands, qModels, genderIntent) {
  const title = normText(itemTitle);
  const store = normText(itemStore);

  let score = 0;

  for (const tok of qTokens) {
    if (title.includes(tok)) score += 3;
  }

  for (const b of qBrands) {
    const bb = normText(b);
    if (title.includes(bb)) score += 12;
    else if (store.includes(bb)) score += 7;
  }

  for (const m of qModels) {
    if (title.includes(m)) score += 14;
    else score -= 10;
  }

  const isKids = KIDS_TERMS.some((k) => title.includes(k));
  const isMen = MEN_TERMS.some((k) => title.includes(k));
  const isWomen = WOMEN_TERMS.some((k) => title.includes(k));

  if (genderIntent === "men") {
    if (isMen) score += 6;
    if (isWomen) score -= 10;
    if (isKids) score -= 12;
  } else if (genderIntent === "women") {
    if (isWomen) score += 6;
    if (isMen) score -= 10;
    if (isKids) score -= 12;
  } else if (genderIntent === "kids") {
    if (isKids) score += 6;
    if (isMen || isWomen) score -= 8;
  }

  if (title.length < 12) score -= 4;

  return score;
}

// HARD GATES: exact enforcement (brand/model/gender + accessory block)
function applyHardGates(items, qBrands, qModels, genderIntent) {
  return items.filter((it) => {
    const title = normText(it.title);
    const store = normText(it.store);

    if (containsAny(title, ACCESSORY_BLOCKLIST)) return false;

    if (qBrands.length) {
      const okBrand = qBrands.some((b) => {
        const bb = normText(b);
        return title.includes(bb) || store.includes(bb);
      });
      if (!okBrand) return false;
    }

    if (qModels.length) {
      const okModel = qModels.some((m) => title.includes(m));
      if (!okModel) return false;
    }

    const isKids = KIDS_TERMS.some((k) => title.includes(k));
    const isMen = MEN_TERMS.some((k) => title.includes(k));
    const isWomen = WOMEN_TERMS.some((k) => title.includes(k));

    if (genderIntent === "men") {
      if (isKids) return false;
      if (isWomen) return false;
    } else if (genderIntent === "women") {
      if (isKids) return false;
      if (isMen) return false;
    } else if (genderIntent === "kids") {
      if (isMen) return false;
      if (isWomen) return false;
    }

    return true;
  });
}

function filterByCondition(items, condition) {
  const cond = normalizeCondition(condition);
  if (cond === "any") return items;

  const isUsedLike = (it) => {
    const s = normText(`${it.secondHand || ""} ${it.title || ""}`);
    return (
      s.includes("used") ||
      s.includes("pre owned") ||
      s.includes("preowned") ||
      s.includes("second hand") ||
      s.includes("secondhand") ||
      s.includes("refurb") ||
      s.includes("refurbished") ||
      s.includes("renewed") ||
      s.includes("open box") ||
      s.includes("open-box")
    );
  };

  if (cond === "used") return items.filter(isUsedLike);
  return items.filter((x) => !isUsedLike(x));
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const urlKey = (it.url || "").toString().trim().toLowerCase();
    const key = urlKey || `${normText(it.title)}__${normText(it.store)}__${it.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function annotateBestDeal(top3, poolItems) {
  if (!top3.length) return top3;

  const pool = (poolItems || []).slice(0, 20);
  const prices = pool
    .map((x) => safeNumber(x.price))
    .filter((p) => Number.isFinite(p) && p > 0);

  const med = median(prices);
  if (!Number.isFinite(med) || med <= 0) {
    return top3.map((r) => ({
      ...r,
      isBestDeal: false,
      savingsVsMedian: 0,
      savingsPctVsMedian: 0,
    }));
  }

  const cheapestIdx = top3.reduce(
    (best, r, i) => (r.price < top3[best].price ? i : best),
    0
  );
  const cheapest = top3[cheapestIdx];

  const savings = +(med - cheapest.price).toFixed(2);
  const savingsPct = +(((med - cheapest.price) / med) * 100).toFixed(0);
  const isBest = savingsPct >= 10 || savings >= 10;

  return top3.map((r, i) => ({
    ...r,
    isBestDeal: isBest && i === cheapestIdx,
    savingsVsMedian: isBest && i === cheapestIdx ? Math.max(0, savings) : 0,
    savingsPctVsMedian: isBest && i === cheapestIdx ? Math.max(0, savingsPct) : 0,
  }));
}

// =====================
// Query expansion (light + cheap)
// =====================
function shouldExpandQuery(q, brands, models) {
  const tokens = tokenize(q);
  if (brands.length || models.length) return tokens.length <= 6;
  return tokens.length <= 4;
}

function expandQueries(q) {
  const base = q.trim();
  const out = [base];

  const add = (x) => {
    const v = x.trim();
    if (!v) return;
    const k = normalizeQueryKey(v);
    if (!out.some((o) => normalizeQueryKey(o) === k)) out.push(v);
  };

  add(`${base} buy`);
  add(`${base} online`);

  return out.slice(0, 3);
}

// =====================
// SerpApi fetch (Google Shopping)
// =====================
async function fetchGoogleShopping(q, country = "GB") {
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
      const price = safeNumber(it.extracted_price);
      if (price === null) return null;

      const link = it.product_link || it.link || "";
      if (!link) return null;

      return {
        title: it.title || "Item",
        store: it.source || "Google Shopping",
        price,
        currency: "GBP",
        url: link,
        secondHand: it.second_hand_condition || "",
      };
    })
    .filter(Boolean);
}

// =====================
// Core search (Exact Match + LEGO-friendly)
// =====================
async function runSearch({ q, country = "GB", store = "Any", condition = "new" }) {
  const qBrands = detectBrands(q);
  const qModels = extractModelNumbers(q);
  const qTokens = tokenize(q);
  const genderIntent = detectGenderIntent(q);

  const queries = shouldExpandQuery(q, qBrands, qModels) ? expandQueries(q) : [q];

  const batches = await Promise.all(
    queries.map(async (qq) => {
      try {
        return await fetchGoogleShopping(qq, country);
      } catch {
        return [];
      }
    })
  );

  let items = dedupe(batches.flat());

  if (store && store.toLowerCase() !== "any") {
    const s = store.toLowerCase();
    items = items.filter((x) => (x.store || "").toLowerCase().includes(s));
  }

  items = filterByCondition(items, condition);

  // HARD GATES (brand/model/gender/accessories)
  items = applyHardGates(items, qBrands, qModels, genderIntent);

  // Score + sort
  const scored = items
    .map((it) => ({
      ...it,
      _score: confidenceScore(it.title, it.store, qTokens, qBrands, qModels, genderIntent),
    }))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return a.price - b.price;
    });

  // ✅ Exact mode: strict when brand/model present, less strict for general toys
  const MIN_SCORE = qBrands.length || qModels.length ? 22 : 12;

  const finalPool = scored.filter((x) => x._score >= MIN_SCORE);

  const poolForStats = [...finalPool].slice(0, 20).sort((a, b) => a.price - b.price);
  const top3 = finalPool.slice(0, 3).map(({ _score, ...rest }) => rest);

  const annotated = annotateBestDeal(top3, poolForStats);

  return { results: annotated };
}

// =====================
// Routes
// =====================
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const country = (req.query.country || "GB").toString().trim().toUpperCase();
    const store = (req.query.store || "Any").toString().trim();
    const condition = normalizeCondition(req.query.condition || "new");

    if (!q) return res.status(400).json({ error: "Missing q" });

    const out = await runSearch({ q, country, store, condition });

    res.json({ query: q, store, condition, results: out.results });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

// =====================
// Price checker (GitHub Actions)
// =====================
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
    let failed = 0;

    for (const row of r.rows) {
      try {
        const deviceId = row.device_id;
        const query = row.query;
        const queryKey = row.query_key;
        const condition = normalizeCondition(row.condition || "new");
        const oldPrice = row.last_price === null ? null : Number(row.last_price);

        const out = await runSearch({ q: query, country: "GB", store: "Any", condition });

        const cheapest = out.results?.length ? out.results[0] : null;
        const newPrice = cheapest ? Number(cheapest.price) : null;

        checked += 1;

        if (newPrice === null || !Number.isFinite(newPrice)) {
          await pool.query(
            `UPDATE tracked_searches SET last_seen_at = NOW()
             WHERE device_id=$1 AND query_key=$2 AND condition=$3`,
            [deviceId, queryKey, condition]
          );
          continue;
        }

        if (oldPrice === null || !Number.isFinite(oldPrice)) {
          await pool.query(
            `UPDATE tracked_searches SET last_price=$1, last_seen_at=NOW()
             WHERE device_id=$2 AND query_key=$3 AND condition=$4`,
            [newPrice, deviceId, queryKey, condition]
          );
          updated += 1;
          continue;
        }

        if (newPrice < oldPrice) {
          await pool.query(
            `INSERT INTO price_drops (device_id, query_key, query, condition, old_price, new_price, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [deviceId, queryKey, query, condition, oldPrice, newPrice, cheapest.currency || "GBP"]
          );
          drops += 1;
        }

        await pool.query(
          `UPDATE tracked_searches SET last_price=$1, last_seen_at=NOW()
           WHERE device_id=$2 AND query_key=$3 AND condition=$4`,
          [newPrice, deviceId, queryKey, condition]
        );
        updated += 1;
      } catch {
        failed += 1;
        checked += 1;
      }
    }

    res.json({ ok: true, checked, updated, drops, failed });
  } catch (e) {
    res.status(500).json({ error: "Price check failed", detail: String(e) });
  }
});

// =====================
// Start
// =====================
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`FNDiT backend listening on ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  });
