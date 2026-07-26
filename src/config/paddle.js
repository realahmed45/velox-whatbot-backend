/**
 * Botlify — Paddle (Billing) configuration.
 *
 * Paddle is our Merchant-of-Record: it hosts checkout (Paddle.js overlay),
 * collects payment worldwide in USD (incl. the 3-day trial with card upfront),
 * handles tax/VAT, and pays out to our bank (ACH → Elevate). We map each
 * Botlify plan + billing cycle to a Paddle "price" id.
 *
 * Required env (set in Render):
 *   PADDLE_API_KEY            — server-side API key (Paddle > Authentication)
 *   PADDLE_WEBHOOK_SECRET     — notification destination signing secret
 *   PADDLE_CLIENT_TOKEN       — client-side token for Paddle.js (starts pdl_… / live_ / sandbox_)
 *   PADDLE_ENV                — "sandbox" or "production" (default production)
 *   PADDLE_PRICE_IG_STARTER_MONTHLY / _ANNUAL
 *   PADDLE_PRICE_IG_PRO_MONTHLY / _ANNUAL
 *
 * The client token + env are ALSO surfaced to the frontend via the billing API
 * so we don't have to hardcode them in the build.
 */

const API_KEY = process.env.PADDLE_API_KEY || "";
const WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || "";
const CLIENT_TOKEN = process.env.PADDLE_CLIENT_TOKEN || "";
const ENVIRONMENT =
  process.env.PADDLE_ENV === "sandbox" ? "sandbox" : "production";

const API_BASE =
  ENVIRONMENT === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";

// plan id + billing cycle → Paddle price id
const PRICES = {
  ig_starter: {
    monthly: process.env.PADDLE_PRICE_IG_STARTER_MONTHLY || "",
    annual: process.env.PADDLE_PRICE_IG_STARTER_ANNUAL || "",
  },
  ig_pro: {
    monthly: process.env.PADDLE_PRICE_IG_PRO_MONTHLY || "",
    annual: process.env.PADDLE_PRICE_IG_PRO_ANNUAL || "",
  },
};

// Reverse map: price id → { plan, cycle } so webhooks can identify the purchase.
const PRICE_TO_PLAN = {};
for (const [plan, cycles] of Object.entries(PRICES)) {
  for (const [cycle, priceId] of Object.entries(cycles)) {
    if (priceId) PRICE_TO_PLAN[String(priceId)] = { plan, cycle };
  }
}

const isConfigured = () => !!API_KEY && !!CLIENT_TOKEN;

const getPriceId = (plan, cycle) => PRICES[plan]?.[cycle] || null;

const planForPrice = (priceId) => PRICE_TO_PLAN[String(priceId)] || null;

module.exports = {
  API_KEY,
  WEBHOOK_SECRET,
  CLIENT_TOKEN,
  ENVIRONMENT,
  API_BASE,
  PRICES,
  isConfigured,
  getPriceId,
  planForPrice,
};
