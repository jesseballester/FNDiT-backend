import express from "express";
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

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

function normText(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

// =====================
// DB init
// =====================
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_logs (
      id BIGSERIAL PRIMARY KEY,
      query TEXT NOT NULL,
      results_count INT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("✅ Database ready");
}

// =====================
// Brand detection
// =====================
const BRANDS = [
  "nike",
  "adidas",
  "puma",
  "new balance",
  "asics",
  "reebok",
  "jordan",
  "converse",
  "vans",
  "lego",
  "north face",
  "the north face"
];

function detectBrands(q) {
  const t = normText(q);
  return BRANDS.filter((b) => t.includes(b));
}

const IMPLICIT_BRANDS = [
  { pattern: /air max|vapormax|pegasus|cortez/i, brand: "nike" },
  { pattern: /samba|gazelle|ultraboost|stan smith/i, brand: "adidas" },
  { pattern: /\b550\b|\b574\b|\b990\b|\b2002r\b/i, brand: "new balance" },
  { pattern: /nuptse/i, brand: "the north face" }
];

function detectImplicitBrand(q, brands) {
  if (brands.length) return null;
  for (const r of IMPLICIT_BRANDS) {
    if (r.pattern.test(q)) return r.brand;
  }
  return null;
}

// =====================
// Query helpers
// =====================
function extractModelNumbers(q) {
  const t = normText(q);
  const nums = t.match(/\b\d{2,6}\b/g) || [];
  return uniq(nums);
}

function tokenize(q) {
  const STOPWORDS = new Set([
    "the","a","an","and","or","for","with","without","to","of","in","on","at","by",
    "new","brand","original","genuine","authentic","size","uk","us","eu","pack","set","bundle"
  ]);

  return uniq(
    normText(q)
      .split(" ")
      .filter(Boolean)
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
  );
}

function looksLikeFootwear(q) {
  const t = normText(q);
  return (
    t.includes("air max") ||
    t.includes("airmax") ||
    t.includes("trainer") ||
    t.includes("trainers") ||
    t.includes("shoe") ||
    t.includes("shoes") ||
    t.includes("sneaker") ||
    t.includes("sneakers") ||
    t.includes("jordan") ||
    t.includes("dunk") ||
    t.includes("samba") ||
    t.includes("gazelle")
  );
}

function isLegoSetIntent(q) {
  const t = normText(q);
  if (!t.includes("lego")) return false;
  if (t.includes("minifig") || t.includes("minifigure") || t.includes("figure")) return false;
  return true;
}

// =====================
// Filters
// =====================
const ACCESSORY_BLOCKLIST = [
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
  "mount",
  "keychain",
  "key ring",
  "lanyard",
  "laces",
  "lace",
  "insole",
  "insoles",
  "shoe cleaner",
  "cleaner",
  "protector spray",
  "spray",
  "shoe care",
  "sock",
  "socks",
  "replacement",
  "repair",
  "hanger",
  "patch",
  "iron on",
  "iron-on",
  "zipper",
  "thread"
];

const LEGO_BLOCK = [
  "minifigure",
  "mini figure",
  "minifig",
  "minifigs",
  "figure",
  "figures",
  "parts",
  "piece",
  "pieces",
  "manual",
  "instructions",
  "display case",
  "display cases",
  "acrylic case",
  "acrylic cases",
  "display box",
  "display boxes",
  "storage box",
  "storage boxes",
  "dustproof case",
  "dust proof case",
  "protective case",
  "perspex case",
  "display stand",
  "display stands",
  "light kit",
  "lighting kit",
  "led kit",
  "led light kit"
];

const BLOCKED_STORES = ["aliexpress", "alibaba"];

const KIDS_TERMS = [
  "kid", "kids", "child", "children", "boy", "boys", "girl", "girls",
  "infant", "newborn", "toddler", "baby", "babies", "youth", "junior", "jr"
];

function containsAny(text, phrases) {
  const t = normText(text);
  return phrases.some((p) => t.includes(normText(p)));
}

function isBlockedStore(store) {
  const s = normText(store);
  return BLOCKED_STORES.some((b) => s.includes(b));
}

// =====================
// Query expansion
// =====================
function expandQueries(q, brands) {
  const out = [q.trim()];

  const add = (x) => {
    const v = x.trim();
    if (!v) return;
    if (!out.some((o) => normalizeQueryKey(o) === normalizeQueryKey(v))) {
      out.push(v);
    }
  };

  if (looksLikeFootwear(q)) {
    add(`${q} trainers`);
    add(`${q} shoes`);
  } else {
    add(`${q} buy`);
    add(`${q} online`);
  }

  if (!brands.length) {
    const t = normText(q);
    if (t.includes("air max") || t.includes("airmax")) add(`Nike ${q}`);
    if (t.includes("samba") || t.includes("gazelle")) add(`Adidas ${q}`);
  }

  return out.slice(0, 3);
}

// =====================
// Fetch
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
    .map((it) => ({
      title: it.title || "Item",
      store: it.source || "Store",
      price: safeNumber(it.extracted_price),
      currency: "GBP",
      url: it.product_link || it.link || ""
    }))
    .filter((x) => x.price && x.url);
}

// =====================
// Scoring
// =====================
function scoreResult(item, q, brands, models) {
  const title = normText(item.title);
  const store = normText(item.store);
  const qText = normText(q);
  const tokens = tokenize(q);

  let score = 0;

  // token overlap
  tokens.forEach((t) => {
    if (title.includes(t)) score += 3;
  });

  // brand boost
  brands.forEach((b) => {
    const bb = normText(b);
    if (title.includes(bb)) score += 10;
    else if (store.includes(bb)) score += 5;
  });

  // model boost / penalty
  models.forEach((m) => {
    if (title.includes(m)) score += 12;
    else score -= 6;
  });

  // kids penalty for adult searches
  const isKids = KIDS_TERMS.some((k) => title.includes(k));
  if (
    isKids &&
    (qText.includes("men") ||
      qText.includes("mens") ||
      qText.includes("women") ||
      qText.includes("womens"))
  ) {
    score -= 12;
  }

  if (title.length < 10) score -= 3;

  return score;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];

  for (const it of items) {
    const key = (it.url || "").toLowerCase() || `${normText(it.title)}__${it.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }

  return out;
}

// =====================
// Search logic
// =====================
async function runSearch(q, country = "GB") {
  let brands = detectBrands(q);
  const implicit = detectImplicitBrand(q, brands);

  if (!brands.length && implicit) {
    brands = [implicit];
  }

  const models = extractModelNumbers(q);
  const legoMode = isLegoSetIntent(q);
  const queries = expandQueries(q, brands);

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

  // Block low-trust stores
  items = items.filter((i) => !isBlockedStore(i.store));

  // Remove general accessories
  items = items.filter((i) => !containsAny(i.title, ACCESSORY_BLOCKLIST));

  // LEGO strict mode
  if (legoMode) {
    items = items.filter((i) => !containsAny(i.title, LEGO_BLOCK));
  }

  // Brand lock first, but allow fallback if it empties everything
  let brandLocked = items;
  if (brands.length) {
    brandLocked = items.filter((i) =>
      brands.some((b) => {
        const bb = normText(b);
        return normText(i.title).includes(bb) || normText(i.store).includes(bb);
      })
    );
    if (brandLocked.length > 0) items = brandLocked;
  }

  // Model lock first, but allow fallback if it empties everything
  let modelLocked = items;
  if (models.length) {
    modelLocked = items.filter((i) =>
      models.some((m) => normText(i.title).includes(m))
    );
    if (modelLocked.length > 0) items = modelLocked;
  }

  // Score + sort
  let scored = items
    .map((i) => ({ ...i, score: scoreResult(i, q, brands, models) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.price - b.price;
    });

  // Strict first
  let filtered = scored.filter((i) => i.score >= (brands.length || models.length ? 12 : 8));

  // ✅ Fallback if too strict
  if (filtered.length === 0) {
    filtered = scored.filter((i) => i.score >= 4);
  }

  return {
    results: filtered.slice(0, 3).map(({ score, ...rest }) => rest)
  };
}

// =====================
// Routes
// =====================
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const store = (req.query.store || "Any").toString();
    const condition = (req.query.condition || "new").toString();
    const country = (req.query.country || "GB").toString().trim().toUpperCase();

    if (!q) {
      return res.status(400).json({ error: "Missing query" });
    }

    const out = await runSearch(q, country);

    await pool.query(
      `INSERT INTO search_logs (query, results_count) VALUES ($1,$2)`,
      [q, out.results.length]
    );

    res.json({
      query: q,
      store,
      condition,
      results: out.results
    });
  } catch (e) {
    res.status(500).json({
      error: "Search failed",
      detail: String(e)
    });
  }
});

app.get("/search-logs", async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT query, results_count, created_at
      FROM search_logs
      ORDER BY created_at DESC
      LIMIT 100
    `);

    res.json({ logs: r.rows });
  } catch (e) {
    res.status(500).json({
      error: "Failed to fetch logs",
      detail: String(e)
    });
  }
});

// =====================
// Start
// =====================
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
});
