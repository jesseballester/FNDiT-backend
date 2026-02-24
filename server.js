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
  return "new";
}

function safeNumber(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

/* ===============================
   DATABASE INIT + MIGRATIONS
================================ */

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

  /* ===== FIX FOR YOUR ERROR ===== */
  await pool.query(`
    ALTER TABLE price_drops
    ADD COLUMN IF NOT EXISTS condition TEXT NOT NULL DEFAULT 'new';
  `);

  console.log("✅ Database ready");
}

/* ===============================
   HEALTH
================================ */

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

/* ===============================
   TRACK SEARCH
================================ */

app.post("/track", async (req, res) => {
  try {
    const { deviceId, query, condition } = req.body;

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

/* ===============================
   UNTRACK
================================ */

app.post("/untrack", async (req, res) => {
  try {
    const { deviceId, query, condition } = req.body;

    const queryKey = normalizeQueryKey(query);
    const cond = normalizeCondition(condition);

    await pool.query(
      `
      DELETE FROM tracked_searches
      WHERE device_id=$1 AND query_key=$2 AND condition=$3
      `,
      [deviceId, queryKey, cond]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Untrack failed", detail: String(e) });
  }
});

/* ===============================
   GET TRACKED SEARCHES
================================ */

app.get("/tracked", async (req, res) => {
  try {
    const deviceId = req.query.deviceId;

    const r = await pool.query(
      `
      SELECT query, condition, last_price, last_seen_at
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

/* ===============================
   SEARCH
================================ */

async function fetchGoogleShopping(q) {
  const url = new URL("https://serpapi.com/search.json");

  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", q);
  url.searchParams.set("gl", "gb");
  url.searchParams.set("hl", "en");
  url.searchParams.set("api_key", SERPAPI_KEY);

  const r = await fetch(url);

  const data = await r.json();

  return (data.shopping_results || [])
    .map((it) => {
      const price = safeNumber(it.extracted_price);

      if (!price) return null;

      return {
        title: it.title || "Item",
        store: it.source || "Google Shopping",
        price,
        currency: "GBP",
        url: it.link || it.product_link || "",
      };
    })
    .filter(Boolean);
}

app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const condition = normalizeCondition(req.query.condition);

    if (!q) return res.status(400).json({ error: "Missing q" });

    const results = await fetchGoogleShopping(q);

    const sorted = results
      .sort((a, b) => a.price - b.price)
      .slice(0, 3);

    res.json({
      query: q,
      condition,
      results: sorted,
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

/* ===============================
   PRICE CHECKER
================================ */

app.get("/run-price-check", async (req, res) => {
  try {
    const secret = req.query.secret;

    if (!CHECK_SECRET || secret !== CHECK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const r = await pool.query(`
      SELECT device_id, query, query_key, condition, last_price
      FROM tracked_searches
    `);

    let checked = 0;
    let updated = 0;
    let drops = 0;

    for (const row of r.rows) {
      const deviceId = row.device_id;
      const query = row.query;
      const queryKey = row.query_key;
      const condition = row.condition;
      const oldPrice = Number(row.last_price);

      const results = await fetchGoogleShopping(query);

      const cheapest = results.sort((a, b) => a.price - b.price)[0];

      if (!cheapest) continue;

      const newPrice = cheapest.price;

      checked++;

      if (!oldPrice || newPrice < oldPrice) {
        if (oldPrice) {
          await pool.query(
            `
            INSERT INTO price_drops
            (device_id, query_key, query, condition, old_price, new_price)
            VALUES ($1,$2,$3,$4,$5,$6)
            `,
            [deviceId, queryKey, query, condition, oldPrice, newPrice]
          );

          drops++;
        }

        await pool.query(
          `
          UPDATE tracked_searches
          SET last_price=$1,last_seen_at=NOW()
          WHERE device_id=$2 AND query_key=$3 AND condition=$4
          `,
          [newPrice, deviceId, queryKey, condition]
        );

        updated++;
      }
    }

    res.json({ ok: true, checked, updated, drops });
  } catch (e) {
    res.status(500).json({ error: "Price check failed", detail: String(e) });
  }
});

/* ===============================
   START SERVER
================================ */

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`FNDiT backend running on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("DB init failed", e);
    process.exit(1);
  });
