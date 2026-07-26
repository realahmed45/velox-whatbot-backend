/**
 * Botlify — Lemon Squeezy service.
 *
 * Thin wrapper over the Lemon Squeezy REST API (https://api.lemonsqueezy.com).
 *  - createCheckout(): hosted checkout URL for a plan variant, tagged with our
 *    workspaceId + userId so the webhook can match the purchase back to us.
 *  - verifyWebhookSignature(): HMAC-SHA256 check of the X-Signature header.
 *  - getCustomerPortalUrl(): the LS-hosted "manage subscription" page (update
 *    card, cancel, invoices) for an existing subscription.
 */
const crypto = require("crypto");
const logger = require("../../utils/logger");
const {
  API_KEY,
  STORE_ID,
  WEBHOOK_SECRET,
  isConfigured,
} = require("../../config/lemonSqueezy");

const BASE = "https://api.lemonsqueezy.com/v1";

const headers = () => ({
  Accept: "application/vnd.api+json",
  "Content-Type": "application/vnd.api+json",
  Authorization: `Bearer ${API_KEY}`,
});

/**
 * Create a hosted checkout for a variant. Prefills the buyer's email and embeds
 * { workspaceId, userId, plan, cycle } in custom data (returned on webhooks).
 * @returns {Promise<string>} the checkout URL to redirect the user to.
 */
async function createCheckout({
  variantId,
  email,
  name,
  workspaceId,
  userId,
  plan,
  cycle,
  redirectUrl,
}) {
  if (!isConfigured()) throw new Error("Lemon Squeezy is not configured");
  if (!variantId) throw new Error("Missing Lemon Squeezy variant id for plan");

  const payload = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          email: email || undefined,
          name: name || undefined,
          // custom fields come back verbatim in webhook meta.custom_data
          custom: {
            workspace_id: String(workspaceId),
            user_id: String(userId || ""),
            plan: String(plan || ""),
            cycle: String(cycle || ""),
          },
        },
        product_options: redirectUrl
          ? { redirect_url: redirectUrl }
          : undefined,
        checkout_options: { embed: false },
      },
      relationships: {
        store: { data: { type: "stores", id: String(STORE_ID) } },
        variant: { data: { type: "variants", id: String(variantId) } },
      },
    },
  };

  const resp = await fetch(`${BASE}/checkouts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[LemonSqueezy] createCheckout failed", {
      status: resp.status,
      body: text.slice(0, 500),
    });
    throw new Error("Could not start checkout. Please try again.");
  }

  const json = await resp.json();
  const url = json?.data?.attributes?.url;
  if (!url) throw new Error("Lemon Squeezy did not return a checkout URL");
  return url;
}

/**
 * Verify an inbound webhook's signature. `rawBody` MUST be the exact bytes LS
 * sent (Buffer/string), not a re-serialized object.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) {
    logger.warn("[LemonSqueezy] no webhook secret set — rejecting webhook");
    return false;
  }
  if (!signatureHeader) return false;
  try {
    const digest = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
      .digest("hex");
    // timing-safe compare
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(String(signatureHeader), "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    logger.warn("[LemonSqueezy] signature check errored", { err: err.message });
    return false;
  }
}

/**
 * Fetch the LS-hosted customer portal URL for a subscription (manage/cancel).
 * @param {string} subscriptionId  Lemon Squeezy subscription id
 */
async function getCustomerPortalUrl(subscriptionId) {
  if (!isConfigured()) throw new Error("Lemon Squeezy is not configured");
  const resp = await fetch(`${BASE}/subscriptions/${subscriptionId}`, {
    headers: headers(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[LemonSqueezy] getSubscription failed", {
      status: resp.status,
      body: text.slice(0, 300),
    });
    throw new Error("Could not open the billing portal.");
  }
  const json = await resp.json();
  const urls = json?.data?.attributes?.urls || {};
  // customer_portal covers update-card/cancel/invoices in one place.
  return urls.customer_portal || urls.update_payment_method || null;
}

/**
 * Cancel a subscription via the API (LS cancels at period end by default).
 */
async function cancelSubscription(subscriptionId) {
  if (!isConfigured()) throw new Error("Lemon Squeezy is not configured");
  const resp = await fetch(`${BASE}/subscriptions/${subscriptionId}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logger.error("[LemonSqueezy] cancel failed", {
      status: resp.status,
      body: text.slice(0, 300),
    });
    throw new Error("Could not cancel the subscription.");
  }
  return true;
}

module.exports = {
  createCheckout,
  verifyWebhookSignature,
  getCustomerPortalUrl,
  cancelSubscription,
};
