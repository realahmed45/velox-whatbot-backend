/**
 * Shopify catalog sync service (G4).
 * Fetches products from a Shopify store and caches them in-memory by workspace.
 * Designed to power DM catalog flows — customer asks "what's available" → bot
 * posts the top products with prices + link.
 *
 * Shopify Admin API docs:
 *   GET https://{shop}.myshopify.com/admin/api/2024-10/products.json
 *
 * Auth: X-Shopify-Access-Token header (custom app / private app token).
 */
const axios = require("axios");
const logger = require("../utils/logger");

const API_VERSION = "2024-10";

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

module.exports = { listProducts, testConnection, normalizeStoreUrl };
