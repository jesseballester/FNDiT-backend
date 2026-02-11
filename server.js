import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const EBAY_CLIENT_ID = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

// --------------------
// eBay OAuth token cache
// --------------------
let ebayTokenCache = {
  token: null,
  expiresAt: 0, // epoch ms
};

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
  ebayTokenCache.expiresAt = now + (data.expires_in * 1000);

  return ebayTokenCache.token;
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

      return {
        title: it.title || "Item",
        store: it.source || "Google Shopping",
        price,
        currency: "GBP",
        url: it.link || it.product_link || "",
        source: "google",
      };
    })
    .filter(Boolean)
    .filter((x) => x.url);
}

// --------------------
// eBay Browse API
// --------------------
async function fetchEbay(q, country) {
  const token = await getEbayAppToken();
  if (!token) return [];

  const marketplaceId = country === "GB" ? "EBAY_GB" : "EBAY_US";

  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "20");
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

  return (data.itemSummaries || [])
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
        condition: it.condition || null,
      };
    })
    .filter(Boolean)
    .filter((x) => x.url);
}

// --------------------
// Routes
// --------------------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fndit-backend" });
});

/**
 * GET /search?q=...&country=GB&store=Any|eBay|Nike|JD|...
 */
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const country = (req.query.country || "GB").toString().trim().toUpperCase();
    const store = (req.query.store || "Any").toString().trim();

    if (!q) return res.status(400).json({ error: "Missing q" });

    const [googleItems, ebayItems] = await Promise.all([
      fetchGoogleShopping(q, country).catch(() => []),
      fetchEbay(q, country).catch(() => []),
    ]);

    // Store filter: eBay only
    if (store.toLowerCase() === "ebay") {
      const top = ebayItems.sort((a, b) => a.price - b.price).slice(0, 3);
      return res.json({ query: q, store, results: top });
    }

    // Merge
    let merged = [...googleItems, ...ebayItems];

    // Optional store filter by name (Nike/JD/Decathlon/etc.)
    if (store && store.toLowerCase() !== "any") {
      const s = store.toLowerCase();
      merged = merged.filter((x) => (x.store || "").toLowerCase().includes(s));
    }

    const top3 = merged.sort((a, b) => a.price - b.price).slice(0, 3);
    res.json({ query: q, store, results: top3 });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`FNDiT backend listening on ${PORT}`);
});
