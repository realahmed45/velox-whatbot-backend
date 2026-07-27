/**
 * Botlify — Creem service.
 *
 *  - createCheckout(): POST /v1/checkouts → hosted checkout URL (redirect),
 *    tagged with our metadata (workspaceId/userId/plan/cycle).
 *  - verifyWebhookSignature(): HMAC-SHA256 of the RAW body vs the
 *    `creem-signature` header, using the webhook secret.
 *  - getPortalLink(): POST /v1/customers/billing → customer portal URL.
 *  - cancelSubscription(): POST /v1/subscriptions/{id}/cancel.
 *
 * Auth: `x-api-key` header. Base URL from config (test vs production).
 */
const crypto = require("crypto");
const logger = require("../../utils/logger");
const {
  API_KEY,
  API_BASE,
  WEBHOOK_SECRET,
  isConfigured,
} = require("../../config/creem");

const headers = () => ({
  "x-api-key": API_KEY,
  "Content-Type": "application/json",
});

/**
 * Create a hosted checkout for a product. Prefills email and attaches metadata
 * that Creem returns verbatim on webhooks.
 * @returns {Promise<string>} the checkout_url to redirect the user to.
 */
async function createCheckout({
  productId,
  email,
  successUrl,
  metadata,
  requestId,
  discountCode,
}) {
  if (!isConfigured()) throw new Error("Creem is not configured");
  if (!productId) throw new Error("Missing Creem product id for plan");

  const body = {
    product_id: productId,
    success_url: successUrl,
    metadata: metadata || {},
    ...(requestId ? { request_id: requestId } : {}),
    ...(email ? { customer: { email } } : {}),
    // Early-bird / promo coupon created in the Creem dashboard. Applied only
    // when the caller passes it (e.g. for eligible founding users).
    ...(discountCode ? { discount_code: discountCode } : {}),
  };

  const resp = await fetch(`${API_BASE}/v1/checkouts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[Creem] createCheckout failed", {
      status: resp.status,
      body: text.slice(0, 500),
    });
    throw new Error("Could not start checkout. Please try again.");
  }
  const json = await resp.json();
  const url = json?.checkout_url || json?.data?.checkout_url;
  if (!url) throw new Error("Creem did not return a checkout URL");
  return url;
}

/**
 * Verify a Creem webhook. Signature = HMAC-SHA256(rawBody, webhookSecret) in
 * the `creem-signature` header. rawBody must be the exact bytes received.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) {
    logger.warn("[Creem] no webhook secret set — rejecting webhook");
    return false;
  }
  if (!signature) return false;
  try {
    const computed = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
      .digest("hex");
    const a = Buffer.from(computed, "utf8");
    const b = Buffer.from(String(signature), "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    logger.warn("[Creem] signature check errored", { err: err.message });
    return false;
  }
}

/** Generate a customer portal link (manage/cancel/invoices). */
async function getPortalLink(customerId) {
  if (!isConfigured()) throw new Error("Creem is not configured");
  if (!customerId) throw new Error("Missing Creem customer id");
  const resp = await fetch(`${API_BASE}/v1/customers/billing`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ customer_id: customerId }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[Creem] getPortalLink failed", {
      status: resp.status,
      body: text.slice(0, 400),
    });
    throw new Error("Could not open the billing portal.");
  }
  const json = await resp.json();
  return (
    json?.customer_portal_link ||
    json?.customerPortalLink ||
    json?.data?.customer_portal_link ||
    null
  );
}

/** Cancel a subscription (schedule at period end). */
async function cancelSubscription(subscriptionId) {
  if (!isConfigured()) throw new Error("Creem is not configured");
  const resp = await fetch(
    `${API_BASE}/v1/subscriptions/${subscriptionId}/cancel`,
    { method: "POST", headers: headers() },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[Creem] cancel failed", {
      status: resp.status,
      body: text.slice(0, 400),
    });
    throw new Error("Could not cancel the subscription.");
  }
  return true;
}

module.exports = {
  createCheckout,
  verifyWebhookSignature,
  getPortalLink,
  cancelSubscription,
};
