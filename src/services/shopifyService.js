/**
 * Shopify catalog sync service.
 *
 * TWO connection methods:
 *   1. Tokenless (public REST) — merchant provides store URL only.
 *      Uses Shopify's public products.json endpoint — works on all public stores.
 *      Zero admin setup required. FREE.
 *      Endpoint: GET https://{shop}.myshopify.com/products.json
 *
 *   2. Admin API (manual token) — for order tracking. Requires merchant to
 *      create a custom app and copy the Admin API access token.
 */
const axios = require("axios");
const logger = require("../utils/logger");

const API_VERSION = "2024-10";

// ─── Public REST (tokenless) ─────────────────────────────────────────────────

/**
 * Fetch products from any public Shopify store with NO token required.
 * Uses the public products.json REST endpoint — works on all public stores.
 */
const listProductsStorefront = async (storeUrl, limit = 50) => {
  const host = normalizeStoreUrl(storeUrl);
  if (!host) throw new Error("Invalid Shopify store URL");

  const { data } = await axios.get(`https://${host}/products.json`, {
    params: { limit: Math.min(limit, 250) },
    headers: { Accept: "application/json" },
    timeout: 10000,
  });

  return (data.products || []).map((p) => {
    const variant = p.variants?.[0];
    return {
      id: `gid://shopify/Product/${p.id}`,
      title: p.title,
      handle: p.handle,
      description: (p.body_html || "").replace(/<[^>]*>/g, "").slice(0, 300),
      image: p.images?.[0]?.src || null,
      price: variant?.price || null,
      currency: null,
      inStock: variant?.available ?? true,
      url: `https://${host}/products/${p.handle}`,
    };
  });
};

/**
 * Verify a store URL is a valid, reachable Shopify store (tokenless).
 * Returns { ok, shopName } or { ok: false, error }.
 */
const testStorefront = async (storeUrl) => {
  const host = normalizeStoreUrl(storeUrl);
  try {
    const { data } = await axios.get(`https://${host}/products.json`, {
      params: { limit: 1 },
      headers: { Accept: "application/json" },
      timeout: 8000,
    });
    if (!data || !Array.isArray(data.products)) {
      throw new Error("Unexpected response from store");
    }
    const shopName = host.replace(".myshopify.com", "");
    return { ok: true, shopName };
  } catch (err) {
    logger.warn(`[shopify:storefront] test failed for ${host}: ${err.message}`);
    const status = err.response?.status;
    let error = err.message;
    if (status === 401 || status === 302) {
      error = "This store is password-protected. Remove the password to connect.";
    } else if (status === 404) {
      error = "Store not found. Check the store name and try again.";
    }
    return { ok: false, error };
  }
};

const normalizeStoreUrl = (raw) => {
  if (!raw) return null;
  let s = raw
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!s.includes(".myshopify.com") && !s.includes(".")) {
    s = `${s}.myshopify.com`;
  }
  return s;
};

const listProducts = async (storeUrl, accessToken, limit = 50) => {
  const host = normalizeStoreUrl(storeUrl);
  if (!host) throw new Error("Invalid Shopify store URL");
  const { data } = await axios.get(
    `https://${host}/admin/api/${API_VERSION}/products.json`,
    {
      params: { limit },
      headers: { "X-Shopify-Access-Token": accessToken },
      timeout: 10000,
    },
  );
  return (data.products || []).map((p) => ({
    id: p.id,
    title: p.title,
    handle: p.handle,
    image: p.image?.src || p.images?.[0]?.src || null,
    price: p.variants?.[0]?.price || null,
    currency: p.variants?.[0]?.currency || null,
    inStock:
      p.variants?.some(
        (v) => v.inventory_quantity == null || v.inventory_quantity > 0,
      ) ?? true,
    url: `https://${host}/products/${p.handle}`,
  }));
};

const normalizeOrder = (o, host) => {
  const fulfillment = (o.fulfillments || [])[0] || {};
  return {
    name: o.name, // e.g. "#1234"
    email: o.email || null,
    createdAt: o.created_at,
    financialStatus: o.financial_status || "unknown", // paid, pending, refunded…
    fulfillmentStatus: o.fulfillment_status || "unfulfilled", // fulfilled, partial, null
    trackingNumber: fulfillment.tracking_number || null,
    trackingUrl:
      fulfillment.tracking_url ||
      (fulfillment.tracking_urls && fulfillment.tracking_urls[0]) ||
      null,
    trackingCompany: fulfillment.tracking_company || null,
    total: o.total_price || null,
    currency: o.currency || null,
    items: (o.line_items || []).map((li) => ({
      title: li.title,
      qty: li.quantity,
    })),
    statusUrl: o.order_status_url || null,
  };
};

/**
 * Look up an order by order number (name) and/or email. Requires the custom
 * app token to have `read_orders` scope — a 401/403 throws err.code="no_scope".
 */
const lookupOrder = async (storeUrl, accessToken, { name, email } = {}) => {
  const host = normalizeStoreUrl(storeUrl);
  if (!host) throw new Error("Invalid Shopify store URL");

  const params = { status: "any", limit: 10 };
  if (name) {
    const clean = String(name).replace(/[^\d]/g, "");
    if (clean) params.name = `#${clean}`;
  }
  if (!params.name && email) params.email = email;
  if (!params.name && !params.email) return null;

  let data;
  try {
    ({ data } = await axios.get(
      `https://${host}/admin/api/${API_VERSION}/orders.json`,
      {
        params,
        headers: { "X-Shopify-Access-Token": accessToken },
        timeout: 10000,
      },
    ));
  } catch (err) {
    if ([401, 403].includes(err.response?.status)) {
      const e = new Error("Order access not granted");
      e.code = "no_scope";
      throw e;
    }
    throw err;
  }

  const orders = data.orders || [];
  if (!orders.length) return null;

  const emailLower = email ? email.toLowerCase() : null;
  const orderNum = name
    ? `#${String(name).replace(/[^\d]/g, "")}`
    : null;

  // Email provided — only return an order that belongs to that email.
  if (emailLower) {
    const byEmail = orders.filter(
      (o) => (o.email || "").toLowerCase() === emailLower,
    );
    if (!byEmail.length) return null;
    if (orderNum) {
      const exact = byEmail.find((o) => o.name === orderNum);
      return normalizeOrder(exact || byEmail[0], host);
    }
    return normalizeOrder(byEmail[0], host);
  }

  // Order number only — safe when the customer supplies #1234 in the DM.
  if (orderNum) {
    const match = orders.find((o) => o.name === orderNum);
    return match ? normalizeOrder(match, host) : null;
  }

  return normalizeOrder(orders[0], host);
};

/** Probe which Admin API scopes the token actually has. */
const verifyScopes = async (storeUrl, accessToken) => {
  const host = normalizeStoreUrl(storeUrl);
  if (!host) throw new Error("Invalid Shopify store URL");
  const headers = { "X-Shopify-Access-Token": accessToken };
  const scopes = { products: false, orders: false };

  try {
    await axios.get(
      `https://${host}/admin/api/${API_VERSION}/products.json`,
      { params: { limit: 1 }, headers, timeout: 8000 },
    );
    scopes.products = true;
  } catch (err) {
    if (![401, 403].includes(err.response?.status)) throw err;
  }

  try {
    await axios.get(
      `https://${host}/admin/api/${API_VERSION}/orders.json`,
      { params: { status: "any", limit: 1 }, headers, timeout: 8000 },
    );
    scopes.orders = true;
  } catch (err) {
    if (![401, 403].includes(err.response?.status)) throw err;
  }

  return scopes;
};

/**
 * Find products matching a free-text query (by title word overlap).
 * Falls back to the first few products if nothing matches.
 */
const searchProducts = async (storeUrl, accessToken, query, limit = 5) => {
  const all = await listProducts(storeUrl, accessToken, 100);
  const words = (String(query || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter((w) => !["the", "and", "for", "you", "your", "have"].includes(w));
  if (!words.length) return all.slice(0, limit);
  const scored = all
    .map((p) => {
      const t = (p.title || "").toLowerCase();
      const score = words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return (scored.length ? scored.map((x) => x.p) : all).slice(0, limit);
};

const testConnection = async (storeUrl, accessToken) => {
  const host = normalizeStoreUrl(storeUrl);
  try {
    const { data } = await axios.get(
      `https://${host}/admin/api/${API_VERSION}/shop.json`,
      {
        headers: { "X-Shopify-Access-Token": accessToken },
        timeout: 8000,
      },
    );
    return { ok: true, shop: data.shop?.name, domain: data.shop?.domain };
  } catch (err) {
    logger.warn(`[shopify] test failed: ${err.message}`);
    return {
      ok: false,
      error: err.response?.data?.errors || err.message,
    };
  }
};

module.exports = {
  listProducts,
  listProductsStorefront,
  testStorefront,
  lookupOrder,
  searchProducts,
  testConnection,
  verifyScopes,
  normalizeStoreUrl,
};
