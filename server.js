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
    t.includes("trainer") ||
    t.includes("shoe") ||
    t.includes("sneaker") ||
    t.includes("jordan") ||
    t.includes("dunk") ||
    t.includes("samba") ||
    t.includes("gazelle")
  );
}

function isLegoSetIntent(q) {
  const t = normText(q);
  if (!t.includes("lego")) return false;
  if (t.includes("minifig") || t.includes("figure")) return false;
  return true;
}

// =====================
// Filters
// =====================
const ACCESSORY_BLOCKLIST = [
  "case","cover","protector","skin","wrap","grip","holder","stand","mount",
  "laces","insole","cleaner","spray","sock","bag","replacement","repair"
];

const LEGO_BLOCK = [
  "minifigure","minifig","figure","parts","piece","manual","instructions",
  "display case","acrylic case","display box","storage box","dustproof case",
  "stand","display stand","light kit","led kit"
];

const BLOCKED_STORES = ["aliexpress","alibaba"];

function containsAny(text, phrases) {
  const t = normText(text);
  return phrases.some(p => t.includes(normText(p)));
}

function isBlockedStore(store) {
  const s = normText(store);
  return BLOCKED_STORES.some(b => s.includes(b));
}

// =====================
// Query expansion
// =====================
function expandQueries(q, brands) {
  const out = [q];

  const add = (x) => {
    if (!out.includes(x)) out.push(x);
  };

  if (looksLikeFootwear(q)) {
    add(`${q} trainers`);
    add(`${q} shoes`);
  } else {
    add(`${q} buy`);
  }

  if (!brands.length) {
    const t = normText(q);
    if (t.includes("air max")) add(`Nike ${q}`);
    if (t.includes("samba")) add(`Adidas ${q}`);
  }

  return out.slice(0, 3);
}

// =====================
// Fetch
// =====================
async function fetchGoogleShopping(q) {
  const url = new URL("https://serpapi.com/search.json");

  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", q);
  url.searchParams.set("api_key", SERPAPI_KEY);

  const r = await fetch(url);
  const data = await r.json();

  return (data.shopping_results || [])
    .map(it => ({
      title: it.title,
      store: it.source,
      price: safeNumber(it.extracted_price),
      currency: "GBP",
      url: it.link
    }))
    .filter(x => x.price && x.url);
}

// =====================
// Scoring
// =====================
function scoreResult(item, q, brands, models) {
  const title = normText(item.title);
  const tokens = tokenize(q);

  let score = 0;

  tokens.forEach(t => {
    if (title.includes(t)) score += 3;
  });

  brands.forEach(b => {
    if (title.includes(normText(b))) score += 10;
  });

  models.forEach(m => {
    if (title.includes(m)) score += 12;
    else score -= 8;
  });

  return score;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(i => {
    const key = i.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// =====================
// Search logic
// =====================
async function runSearch(q) {
  let brands = detectBrands(q);
  const implicit = detectImplicitBrand(q, brands);

  if (!brands.length && implicit) {
    brands = [implicit];
  }

  const models = extractModelNumbers(q);
  const legoMode = isLegoSetIntent(q);

  const queries = expandQueries(q, brands);

  const batches = await Promise.all(
    queries.map(q => fetchGoogleShopping(q))
  );

  let items = dedupe(batches.flat());

  // Block bad stores
  items = items.filter(i => !isBlockedStore(i.store));

  // Remove accessories
  items = items.filter(i => !containsAny(i.title, ACCESSORY_BLOCKLIST));

  // LEGO strict
  if (legoMode) {
    items = items.filter(i => !containsAny(i.title, LEGO_BLOCK));
  }

  // Brand filter
  if (brands.length) {
    items = items.filter(i =>
      brands.some(b => normText(i.title).includes(b))
    );
  }

  // Model filter
  if (models.length) {
    items = items.filter(i =>
      models.some(m => normText(i.title).includes(m))
    );
  }

  // Score + sort
  items = items
    .map(i => ({ ...i, score: scoreResult(i, q, brands, models) }))
    .filter(i => i.score >= 10)
    .sort((a, b) => b.score - a.score || a.price - b.price);

  return { results: items.slice(0, 3) };
}

// =====================
// Routes
// =====================
app.get("/", (req, res) => {
  res.json({ ok: true });
});

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing query" });

  const out = await runSearch(q);

  await pool.query(
    `INSERT INTO search_logs (query, results_count) VALUES ($1,$2)`,
    [q, out.results.length]
  );

  res.json({
    query: q,
    store: "Any",
    condition: "new",
    results: out.results
  });
});

app.get("/search-logs", async (req, res) => {
  const r = await pool.query(`
    SELECT query, results_count, created_at
    FROM search_logs
    ORDER BY created_at DESC
    LIMIT 100
  `);

  res.json({ logs: r.rows });
});

// =====================
// Start
// =====================
initDb().then(() => {
  app.listen(PORT, () => console.log("Server running"));
});
