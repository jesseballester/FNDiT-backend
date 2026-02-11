// server.js
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
// eBay Browse API (ONLY used when store=eBay)
// Default: NEW items only
// Optional: allow condition=used to show used items when user explicitly asks
// --------------------
async function fetchEbay(q, country, condition = "new") {
  const token = await getEbayAppToken();
  if (!token) return [];

  const marketplaceId = country === "GB" ? "EBAY_GB" : "EBAY_US";

  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "30");
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

  // Default: NEW only (unless condition=used explicitly)
  const cond = (condition || "new").toLowerCase();
  if (cond === "new") {
    items = items.filter((x) => (x.condition || "").toLowerCase() === "new");
  } else if (cond === "used") {
    items = items.filter((x) => (x.condition || "").toLowerCase().includes("used"));
  }
  // else: if condition is unknown, leave items as-is (but you can restrict if you prefer)

  return items;
}

// --------------------
// Optional: light “junk” filter (prevents ultra-cheap accessories hijacking results)
// Applied to Google results (since eBay is opt-in now)
// --------------------
function looksLikeFootwearOrClothing(q) {
  const s = q.toLowerCase();
  const keywords = [
    "shoe",
    "shoes",
    "trainer",
    "trainers",
    "sneaker",
    "sneakers",
    "air max",
    "nike",
    "adidas",
    "puma",
    "jordans",
    "hoodie",
    "t-shirt",
    "jeans",
    "jacket",
  ];
  return keywords.some((k) => s.includes(k));
}

function filterJunkForFashion(items) {
  const banned = [
    "phone case",
    "case for",
    "iphone case",
    "iphone",
    "samsung case",
    "cover",
    "screen protector",
    "tempered glass",
    "camera lens protector",
  ];
  return items.filter((x) => {
    const t = (x.title || "").toLowerCase();
    return !banned.some((b) => t.includes(b));
  });
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
 * IMPORTANT BEHAVIOUR (as requested):
 * - Default ("Any"): Google Shopping only (no eBay mixed in)
 * - store=eBay: eBay results only
 * - eBay default condition = new (no used unless explicitly requested)
 */
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    const country = (req.query.country || "GB").toString().trim().toUpperCase();
    const store = (req.query.store || "Any").toString().trim();
    const condition = (req.query.condition || "new").toString().trim(); // for eBay only

    if (!q) return res.status(400).json({ error: "Missing q" });

    // If user explicitly selected eBay, return ONLY eBay results (NEW by default)
    if (store.toLowerCase() === "ebay") {
      const ebayItems = await fetchEbay(q, country, condition).catch(() => []);
      const top = ebayItems.sort((a, b) => a.price - b.price).slice(0, 3);
      return res.json({ query: q, store, condition, results: top });
    }

    // Default: Google Shopping only
    let googleItems = await fetchGoogleShopping(q, country).catch(() => []);

    // Optional “junk” filtering for fashion-ish queries
    if (looksLikeFootwearOrClothing(q)) {
      googleItems = filterJunkForFashion(googleItems);
    }

    // Optional store filter by store name (works for Google sources)
    let filtered = googleItems;
    if (store && store.toLowerCase() !== "any") {
      const s = store.toLowerCase();
      filtered = filtered.filter((x) => (x.store || "").toLowerCase().includes(s));
    }

    const top3 = filtered.sort((a, b) => a.price - b.price).slice(0, 3);
    res.json({ query: q, store, results: top3 });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`FNDiT backend listening on ${PORT}`);
});
