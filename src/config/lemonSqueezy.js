/**
 * Botlify — Lemon Squeezy configuration.
 *
 * Lemon Squeezy is our Merchant-of-Record: it hosts checkout, collects payment
 * (incl. the 3-day trial with card upfront), handles tax/VAT, and pays out to
 * our bank. We map each Botlify plan + billing cycle to a Lemon Squeezy
 * "variant" id (each product price is a variant).
 *
 * Required env (set in Render):
 *   LEMONSQUEEZY_API_KEY          — API key (Settings → API)
 *   LEMONSQUEEZY_STORE_ID         — your store id (Settings → Stores)
 *   LEMONSQUEEZY_WEBHOOK_SECRET   — the signing secret you set when creating the webhook
 *   LS_VARIANT_IG_STARTER_MONTHLY — variant id for Basic monthly
 *   LS_VARIANT_IG_STARTER_ANNUAL  — variant id for Basic yearly
 *   LS_VARIANT_IG_PRO_MONTHLY     — variant id for Pro monthly
 *   LS_VARIANT_IG_PRO_ANNUAL      — variant id for Pro yearly
 */

const API_KEY = process.env.LEMONSQUEEZY_API_KEY || "";
const STORE_ID = process.env.LEMONSQUEEZY_STORE_ID || "";
const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || "";

// plan id + billing cycle → Lemon Squeezy variant id
const VARIANTS = {
  ig_starter: {
    monthly: process.env.LS_VARIANT_IG_STARTER_MONTHLY || "",
    annual: process.env.LS_VARIANT_IG_STARTER_ANNUAL || "",
  },
  ig_pro: {
    monthly: process.env.LS_VARIANT_IG_PRO_MONTHLY || "",
    annual: process.env.LS_VARIANT_IG_PRO_ANNUAL || "",
  },
};

// Reverse map: variant id → { plan, cycle } so the webhook can identify what
// the customer bought.
const VARIANT_TO_PLAN = {};
for (const [plan, cycles] of Object.entries(VARIANTS)) {
  for (const [cycle, variantId] of Object.entries(cycles)) {
    if (variantId) VARIANT_TO_PLAN[String(variantId)] = { plan, cycle };
  }
}

const isConfigured = () => !!API_KEY && !!STORE_ID;

const getVariantId = (plan, cycle) => VARIANTS[plan]?.[cycle] || null;

const planForVariant = (variantId) =>
  VARIANT_TO_PLAN[String(variantId)] || null;

module.exports = {
  API_KEY,
  STORE_ID,
  WEBHOOK_SECRET,
  VARIANTS,
  isConfigured,
  getVariantId,
  planForVariant,
};
