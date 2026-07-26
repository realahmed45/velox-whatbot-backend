/**
 * Botlify — Creem configuration.
 *
 * Creem is our Merchant-of-Record: hosted checkout (redirect), collects payment
 * worldwide in USD (incl. the 3-day trial with card upfront), handles tax, and
 * pays out to our bank / USDC. We map each Botlify plan + billing cycle to a
 * Creem "product" id (trial is configured on the product in the dashboard).
 *
 * Required env (set in Render):
 *   CREEM_API_KEY            — server-side API key (Developers → API Keys)
 *   CREEM_WEBHOOK_SECRET     — webhook signing secret (Developers → Webhooks)
 *   CREEM_ENV                — "test" or "production" (default production)
 *   CREEM_PRODUCT_IG_STARTER_MONTHLY / _ANNUAL
 *   CREEM_PRODUCT_IG_PRO_MONTHLY / _ANNUAL
 */

const API_KEY = process.env.CREEM_API_KEY || "";
const WEBHOOK_SECRET = process.env.CREEM_WEBHOOK_SECRET || "";
const ENVIRONMENT = process.env.CREEM_ENV === "test" ? "test" : "production";

const API_BASE =
  ENVIRONMENT === "test"
    ? "https://test-api.creem.io"
    : "https://api.creem.io";

// plan id + billing cycle → Creem product id
const PRODUCTS = {
  ig_starter: {
    monthly: process.env.CREEM_PRODUCT_IG_STARTER_MONTHLY || "",
    annual: process.env.CREEM_PRODUCT_IG_STARTER_ANNUAL || "",
  },
  ig_pro: {
    monthly: process.env.CREEM_PRODUCT_IG_PRO_MONTHLY || "",
    annual: process.env.CREEM_PRODUCT_IG_PRO_ANNUAL || "",
  },
};

// Reverse map: product id → { plan, cycle } so webhooks can identify purchases.
const PRODUCT_TO_PLAN = {};
for (const [plan, cycles] of Object.entries(PRODUCTS)) {
  for (const [cycle, productId] of Object.entries(cycles)) {
    if (productId) PRODUCT_TO_PLAN[String(productId)] = { plan, cycle };
  }
}

const isConfigured = () => !!API_KEY;

const getProductId = (plan, cycle) => PRODUCTS[plan]?.[cycle] || null;

const planForProduct = (productId) => PRODUCT_TO_PLAN[String(productId)] || null;

module.exports = {
  API_KEY,
  WEBHOOK_SECRET,
  ENVIRONMENT,
  API_BASE,
  PRODUCTS,
  isConfigured,
  getProductId,
  planForProduct,
};
