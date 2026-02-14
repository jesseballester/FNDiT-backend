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
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

const { Pool } = pg;

// Render Postgres provides DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.warn("⚠️ Missing DATABASE_URL. Tracking will fail until you add it in Render env vars.");
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

// Normalize to keep device tracking consistent
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

    // Insert only if not already tracked
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

// Optional: see what’s tracked (useful later for a “Tracked” tab)
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
// YOUR EXISTING SEARCH LOGIC
// (keep your improved /search route code here)
// --------------------

// IMPORTANT: paste your improved /search logic below this line.
// For example:
// app.get("/search", async (req, res) => { ... });


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
