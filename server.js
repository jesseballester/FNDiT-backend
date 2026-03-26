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

// =====================
// DB INIT
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
  "lego"
];

function detectBrands(q) {
  const t = normText(q);
  return BRANDS.filter(b => t.includes(b));
}

// =====================
// Implicit brand logic
// =====================
const IMPLICIT = [
  { pattern: /air max|vapormax|pegasus/i, brand: "nike" },
  { pattern: /samba|gazelle|ultraboost/i, brand: "adidas" }
];

function detectImplicit(q, brands) {
  if (brands.length) return null;
  for (const r of IMPLICIT) {
    if (r.pattern.test(q)) return r.brand;
  }
  return null;
}

// =====================
// LEGO strict filter
// =====================
const LEGO_BLOCK = [
  "minifigure",
  "figure",
  "parts",
  "pieces",
  "manual",
  "instructions"
];

function isLegoSet(q) {
  const t = normText(q);
  if (!t.includes("lego")) return false;
  if (t.includes("minifig") || t.includes("figure")) return false;
  return true;
}

// =====================
// Fetch Google Shopping
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
      title: it.title || "Item",
      store: it.source || "Store",
      price: safeNumber(it.extracted_price),
      currency: "GBP",
      url: it.link || ""
    }))
    .filter(x => x.price && x.url);
}

// =====================
// Search logic
// =====================
async function runSearch(q) {
  let brands = detectBrands(q);
  const implicit = detectImplicit(q, brands);

  if (!brands.length && implicit) {
    brands = [implicit];
  }

  const legoMode = isLegoSet(q);

  let items = await fetchGoogleShopping(q);

  // LEGO strict mode
  if (legoMode) {
    items = items.filter(i => {
      const t = normText(i.title);
      return !LEGO_BLOCK.some(b => t.includes(b));
    });
  }

  // Brand filter
  if (brands.length) {
    items = items.filter(i =>
      brands.some(b => normText(i.title).includes(b))
    );
  }

  // Sort by price
  items.sort((a, b) => a.price - b.price);

  return {
    results: items.slice(0, 3)
  };
}

// =====================
// Routes
// =====================

// Health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

// Search
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const store = (req.query.store || "Any").toString();
    const condition = (req.query.condition || "new").toString();

    if (!q) {
      return res.status(400).json({ error: "Missing query" });
    }

    const out = await runSearch(q);

    // Log search
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

// View logs
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
  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
});
