/**
 * Botlify — Paddle (Billing) service.
 *
 *  - verifyWebhookSignature(): validates the Paddle-Signature header
 *    (ts=…;h1=…) — HMAC-SHA256 over "ts:rawBody" using the webhook secret.
 *  - createPortalSession(): a Paddle-hosted customer portal URL for a customer
 *    (manage/cancel/update card/invoices).
 *  - cancelSubscription(): cancel at period end via the API.
 *
 * Checkout itself is opened client-side with Paddle.js (overlay), so there is
 * no server "create checkout" call — the frontend gets the price id + client
 * token from the billing API and calls Paddle.Checkout.open().
 */
const crypto = require("crypto");
const logger = require("../../utils/logger");
const {
  API_KEY,
  API_BASE,
  WEBHOOK_SECRET,
  isConfigured,
} = require("../../config/paddle");

const headers = () => ({
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
});

/**
 * Verify a Paddle webhook. `rawBody` must be the exact bytes Paddle sent.
 * Header format: "ts=1671552777;h1=<hex hmac of `ts:rawBody`>".
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) {
    logger.warn("[Paddle] no webhook secret set — rejecting webhook");
    return false;
  }
  if (!signatureHeader) return false;
  try {
    const parts = String(signatureHeader)
      .split(";")
      .reduce((acc, kv) => {
        const [k, v] = kv.split("=");
        if (k && v) acc[k.trim()] = v.trim();
        return acc;
      }, {});
    const ts = parts.ts;
    const h1 = parts.h1;
    if (!ts || !h1) return false;

    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const signedPayload = Buffer.concat([
      Buffer.from(`${ts}:`, "utf8"),
      body,
    ]);
    const digest = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(signedPayload)
      .digest("hex");

    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(h1, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    logger.warn("[Paddle] signature check errored", { err: err.message });
    return false;
  }
}

/**
 * Create a customer-portal session for a Paddle customer. Returns the general
 * portal URL (manage/cancel/update card/invoices). Optionally scope to a
 * subscription so "Manage" deep-links to it.
 */
async function createPortalSession(customerId, subscriptionId) {
  if (!isConfigured()) throw new Error("Paddle is not configured");
  if (!customerId) throw new Error("Missing Paddle customer id");

  const body = subscriptionId
    ? { subscription_ids: [subscriptionId] }
    : undefined;

  const resp = await fetch(
    `${API_BASE}/customers/${customerId}/portal-sessions`,
    {
      method: "POST",
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[Paddle] createPortalSession failed", {
      status: resp.status,
      body: text.slice(0, 400),
    });
    throw new Error("Could not open the billing portal.");
  }
  const json = await resp.json();
  const urls = json?.data?.urls || {};
  // general.overview = portal home; subscription deep-link if we scoped it.
  return (
    urls.general?.overview ||
    urls.subscriptions?.[0]?.overview ||
    urls.general?.cancel_subscription ||
    null
  );
}

/** Cancel a subscription (Paddle schedules it for the end of the period). */
async function cancelSubscription(subscriptionId) {
  if (!isConfigured()) throw new Error("Paddle is not configured");
  const resp = await fetch(
    `${API_BASE}/subscriptions/${subscriptionId}/cancel`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ effective_from: "next_billing_period" }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[Paddle] cancel failed", {
      status: resp.status,
      body: text.slice(0, 400),
    });
    throw new Error("Could not cancel the subscription.");
  }
  return true;
}

module.exports = {
  verifyWebhookSignature,
  createPortalSession,
  cancelSubscription,
};
