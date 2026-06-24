/**
 * Botlify — Xendit payment service (card-only recurring subscriptions).
 *
 * Flow:
 *   1. createSubscriptionCheckout() → returns a Xendit-hosted URL where the
 *      customer enters their card (3DS). Xendit tokenizes the card, charges the
 *      first cycle immediately, then AUTO-charges every cycle after that.
 *   2. Xendit fires webhooks (recurring.cycle.succeeded, etc.) which we handle
 *      in billingController to activate / extend / downgrade the plan.
 *   3. deactivatePlan() cancels future auto-charges.
 *
 * Auth: Xendit uses HTTP Basic auth with the secret key as the username and an
 * empty password. Webhooks are verified with a static `x-callback-token`
 * header that you configure in the Xendit dashboard.
 *
 * Required env:
 *   XENDIT_SECRET_KEY       server-side secret API key
 *   XENDIT_WEBHOOK_TOKEN    the dashboard "callback verification token"
 *   XENDIT_SUCCESS_URL      where Xendit redirects after a successful link
 *   XENDIT_FAILURE_URL      where Xendit redirects on failure/cancel
 *   XENDIT_COUNTRY          merchant country (default "ID")
 *   XENDIT_BASE_URL         optional override (default https://api.xendit.co)
 *   XENDIT_API_VERSION      optional api-version header (default 2026-01-01)
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const BASE = (process.env.XENDIT_BASE_URL || "https://api.xendit.co").replace(
  /\/$/,
  "",
);
const KEY = process.env.XENDIT_SECRET_KEY;
const WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN;
const API_VERSION = process.env.XENDIT_API_VERSION || "2026-01-01";
const COUNTRY = process.env.XENDIT_COUNTRY || "ID";

const isConfigured = () => !!KEY && !KEY.startsWith("your_");

const client = () =>
  axios.create({
    baseURL: BASE,
    auth: { username: KEY, password: "" },
    headers: { "Content-Type": "application/json", "api-version": API_VERSION },
    timeout: 20000,
  });

// frontend billing cycle → Xendit schedule interval
const INTERVAL = { monthly: "MONTH", annual: "YEAR" };

/**
 * Create a hosted card-subscription checkout. The customer is sent to Xendit's
 * secure page to enter their card; we never touch raw card data.
 *
 * NOTE: This builds a Payment Session in SUBSCRIPTION mode. The exact field
 * names should be confirmed against your account's API version in the sandbox;
 * the payload below follows Xendit's documented subscription session shape and
 * the response parsing is tolerant of the common URL keys.
 *
 * @returns {Promise<{ url: string, sessionId: string, raw: object }>}
 */
const createSubscriptionCheckout = async ({
  referenceId,
  amount,
  currency = "USD",
  billingCycle = "monthly",
  customer,
  description,
  successUrl,
  failureUrl,
  metadata = {},
}) => {
  if (!isConfigured()) throw new Error("Xendit not configured");

  const payload = {
    reference_id: referenceId,
    session_type: "PAY",
    mode: "SUBSCRIPTION",
    currency,
    amount,
    country: COUNTRY,
    locale: "en",
    allow_save_payment_method: true,
    customer: {
      reference_id: customer.referenceId,
      type: "INDIVIDUAL",
      email: customer.email,
      ...(customer.name
        ? { individual_detail: { given_names: customer.name } }
        : {}),
    },
    channel_properties: {
      success_return_url: successUrl,
      failure_return_url: failureUrl,
    },
    // Recurring schedule — Xendit auto-charges the saved card each cycle.
    recurring: {
      recurring_action: "PAYMENT",
      currency,
      amount,
      immediate_action_type: "FULL_AMOUNT", // charge the first cycle now
      failed_cycle_action: "STOP", // stop auto-charging after retries exhausted
      schedule: {
        reference_id: `sch-${referenceId}`,
        interval: INTERVAL[billingCycle] || "MONTH",
        interval_count: 1,
      },
    },
    metadata,
    description,
  };

  logger.info("[Xendit] creating subscription checkout", {
    referenceId,
    amount,
    currency,
    billingCycle,
  });

  const { data } = await client().post("/v1/payment_sessions", payload);

  const url =
    data.payment_link_url ||
    data.url ||
    data.checkout_url ||
    (Array.isArray(data.actions)
      ? data.actions.find((a) => a.url)?.url
      : null);

  if (!url) {
    logger.error("[Xendit] no checkout URL in response", {
      keys: Object.keys(data || {}),
    });
    throw new Error("Xendit did not return a checkout URL");
  }

  return {
    url,
    sessionId: data.payment_session_id || data.id || referenceId,
    raw: data,
  };
};

/**
 * Cancel future auto-charges for a recurring plan.
 */
const deactivatePlan = async (planId) => {
  if (!isConfigured() || !planId) return { success: false };
  try {
    const { data } = await client().post(`/recurring/plans/${planId}/deactivate`);
    return { success: true, data };
  } catch (err) {
    logger.warn("[Xendit] deactivatePlan failed", {
      planId,
      error: err.response?.data || err.message,
    });
    return { success: false, error: err.response?.data || err.message };
  }
};

/**
 * Verify the inbound webhook using the static callback token header.
 */
const verifyWebhook = (req) => {
  if (!WEBHOOK_TOKEN) {
    // If no token configured we cannot verify — fail closed in production.
    return process.env.NODE_ENV !== "production";
  }
  const token =
    req.headers["x-callback-token"] || req.headers["X-CALLBACK-TOKEN"];
  return token === WEBHOOK_TOKEN;
};

module.exports = {
  isConfigured,
  createSubscriptionCheckout,
  deactivatePlan,
  verifyWebhook,
};
