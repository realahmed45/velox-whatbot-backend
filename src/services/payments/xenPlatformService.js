/**
 * xenPlatformService — Xendit for Platforms (xenPlatform): every guest payment
 * goes through Botlify, Botlify keeps its cut, the hotel gets the rest, and
 * drivers + consultants are paid out automatically.
 *
 * Money model (why it's shaped this way):
 *   - Each hotel is a MANAGED sub-account under Botlify's Xendit master account.
 *     The hotel completes its own KYC (Xendit emails it an invite), so the hotel
 *     is the merchant of record for its room money — Botlify never "holds" a
 *     guest's room payment, which keeps us out of payment-licence territory.
 *   - A payment link (Invoice) is created FOR the hotel's sub-account
 *     (`for-user-id`) WITH a split rule (`with-split-rule`) that routes Botlify's
 *     percentage to the master account the moment the payment settles.
 *   - Botlify's own service (airport pickups with Botlify drivers) is invoiced on
 *     the master account directly — Botlify is the merchant for its own service.
 *   - Drivers and consultants are paid from the master balance with the Payouts
 *     API (any Indonesian bank or e-wallet: ID_BCA, ID_MANDIRI, ID_GOPAY, ID_OVO,
 *     ID_DANA, …).
 *
 * API (docs.xendit.co):
 *   accounts     POST /v2/accounts {email, type:"MANAGED", public_profile:{business_name}}
 *                GET  /v2/accounts/{id} → status INVITED|REGISTERED|AWAITING_DOCS|LIVE|SUSPENDED
 *   split rules  POST /split_rules {name, routes:[{percent_amount, currency,
 *                destination_account_id, reference_id}]} → {id:"splitru_…"}
 *   invoices     POST /v2/invoices (headers for-user-id, with-split-rule)
 *                → {id, invoice_url, status}; webhook status PAID|SETTLED|EXPIRED
 *   payouts      POST /v2/payouts (header Idempotency-key) {reference_id,
 *                channel_code, channel_properties:{account_number,
 *                account_holder_name}, amount, currency, description}
 *                webhook event payout.succeeded|payout.failed|payout.reversed
 *   auth         HTTP Basic, secret key as username. Webhooks carry the static
 *                x-callback-token from the dashboard.
 *
 * Env:
 *   XENDIT_SECRET_KEY         master account secret key (xenPlatform enabled)
 *   XENDIT_WEBHOOK_TOKEN      callback verification token
 *   XENDIT_MASTER_ACCOUNT_ID  master Business ID (split destination; optional —
 *                             Xendit defaults an empty destination to the master)
 */
const axios = require("axios");

const BASE = () => (process.env.XENDIT_BASE_URL || "https://api.xendit.co").replace(/\/$/, "");
const KEY = () => process.env.XENDIT_SECRET_KEY || "";

const isConfigured = () => !!KEY() && !KEY().startsWith("your_");

const client = (headers = {}) =>
  axios.create({
    baseURL: BASE(),
    auth: { username: KEY(), password: "" },
    headers: { "Content-Type": "application/json", ...headers },
    timeout: 20000,
  });

const errText = (err) => {
  const d = err.response?.data;
  return d?.message || d?.error_code || err.message;
};

/** Xendit wants whole units for IDR; other currencies keep 2 decimals. */
const roundFor = (amount, currency) =>
  String(currency).toUpperCase() === "IDR"
    ? Math.round(Number(amount) || 0)
    : Math.round((Number(amount) || 0) * 100) / 100;

// ── Hotel sub-accounts ──────────────────────────────────────────────────────

/** Create a MANAGED sub-account; Xendit emails the hotel to finish KYC. */
async function createSubAccount({ email, businessName }) {
  const { data } = await client().post("/v2/accounts", {
    email,
    type: "MANAGED",
    public_profile: { business_name: String(businessName || "Hotel").slice(0, 100) },
  });
  if (!data?.id) throw new Error("Xendit didn't return a sub-account id");
  return { accountId: data.id, status: String(data.status || "INVITED").toUpperCase() };
}

async function getSubAccount(accountId) {
  const { data } = await client().get(`/v2/accounts/${encodeURIComponent(accountId)}`);
  return { accountId: data?.id || accountId, status: String(data?.status || "UNKNOWN").toUpperCase() };
}

// ── Split rules (one per percentage — destination is always Botlify) ────────

const splitRuleCache = new Map(); // "10" → "splitru_…"

/**
 * The split-rule id that sends `percent`% of a payment to Botlify. Rules are
 * global (not per hotel): the source is whichever sub-account the payment is
 * made for, the destination is always the master. Cached in memory and in
 * PlatformConfig so we create each percentage once, ever.
 */
async function splitRuleFor(percent, currency = "IDR") {
  const pct = Math.round(Number(percent) * 100) / 100;
  if (!(pct > 0 && pct < 100)) return null;
  const key = `xendit.splitRule.${currency}.${pct}`;
  if (splitRuleCache.has(key)) return splitRuleCache.get(key);

  const PlatformConfig = require("../../models/PlatformConfig");
  const saved = await PlatformConfig.get(key);
  if (saved) {
    splitRuleCache.set(key, saved);
    return saved;
  }
  const route = {
    percent_amount: pct,
    currency,
    reference_id: `botlify-fee-${pct}`,
  };
  if (process.env.XENDIT_MASTER_ACCOUNT_ID) route.destination_account_id = process.env.XENDIT_MASTER_ACCOUNT_ID;
  const { data } = await client().post("/split_rules", {
    name: `Botlify fee ${pct}%`,
    description: `Botlify platform fee (${pct}%) on hotel payments`,
    routes: [route],
  });
  if (!data?.id) throw new Error("Xendit didn't return a split rule id");
  await PlatformConfig.set(key, data.id);
  splitRuleCache.set(key, data.id);
  return data.id;
}

// ── Payment links (Invoices) ────────────────────────────────────────────────

/**
 * Hosted payment page: cards, QRIS, virtual accounts, GoPay/OVO/DANA/ShopeePay,
 * retail outlets — whatever the receiving account has activated.
 *
 * @param {object} p
 * @param {string} p.externalId      our reference (Payment._id)
 * @param {string} [p.forUserId]     hotel sub-account (omit → master account)
 * @param {string} [p.splitRuleId]   Botlify's cut (only with forUserId)
 */
async function createInvoice({
  externalId,
  amount,
  currency = "IDR",
  description,
  payerEmail,
  customerName,
  customerPhone,
  forUserId,
  splitRuleId,
  successUrl,
  failureUrl,
  expirySeconds = 3 * 24 * 3600,
  items,
}) {
  const headers = {};
  if (forUserId) headers["for-user-id"] = forUserId;
  if (forUserId && splitRuleId) headers["with-split-rule"] = splitRuleId;
  const body = {
    external_id: String(externalId),
    amount: roundFor(amount, currency),
    currency: String(currency).toUpperCase(),
    description: String(description || "Payment").slice(0, 250),
    invoice_duration: expirySeconds,
    ...(payerEmail ? { payer_email: payerEmail } : {}),
    customer: {
      ...(customerName ? { given_names: String(customerName).slice(0, 50) } : {}),
      ...(payerEmail ? { email: payerEmail } : {}),
      ...(customerPhone ? { mobile_number: `+${String(customerPhone).replace(/[^\d]/g, "")}` } : {}),
    },
    ...(successUrl ? { success_redirect_url: successUrl } : {}),
    ...(failureUrl ? { failure_redirect_url: failureUrl } : {}),
    ...(Array.isArray(items) && items.length ? { items } : {}),
  };
  const { data } = await client(headers).post("/v2/invoices", body);
  if (!data?.invoice_url) throw new Error("Xendit didn't return a payment link");
  return { invoiceId: data.id, url: data.invoice_url, status: String(data.status || "PENDING").toUpperCase(), expiresAt: data.expiry_date ? new Date(data.expiry_date) : null };
}

// ── Payouts (drivers, consultants) ──────────────────────────────────────────

async function createPayout({ referenceId, channelCode, accountNumber, accountHolderName, amount, currency = "IDR", description }) {
  const { data } = await client({ "Idempotency-key": String(referenceId) }).post("/v2/payouts", {
    reference_id: String(referenceId),
    channel_code: channelCode,
    channel_properties: {
      account_number: String(accountNumber),
      account_holder_name: String(accountHolderName),
    },
    amount: roundFor(amount, currency),
    currency: String(currency).toUpperCase(),
    description: String(description || "Botlify payout").slice(0, 100),
  });
  return { payoutId: data?.id || null, status: String(data?.status || "ACCEPTED").toUpperCase() };
}

// ── Webhooks ────────────────────────────────────────────────────────────────

function verifyCallback(req) {
  const expected = process.env.XENDIT_WEBHOOK_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  const got = String(req.headers["x-callback-token"] || "");
  if (got.length !== expected.length) return false;
  return require("crypto").timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/**
 * Normalise any Xendit callback we care about.
 * → {type:"invoice", externalId, invoiceId, status, method, paidAmount}
 * → {type:"payout", referenceId, payoutId, status, failureCode}
 * → null for anything else.
 */
function parseCallback(body = {}) {
  const event = String(body.event || "").toLowerCase();
  if (event.startsWith("payout.")) {
    const d = body.data || {};
    return {
      type: "payout",
      referenceId: d.reference_id || null,
      payoutId: d.id || null,
      status: String(d.status || event.split(".")[1] || "").toUpperCase(),
      failureCode: d.failure_code || null,
    };
  }
  // Invoice callbacks are flat objects with external_id + status.
  if (body.external_id && body.status) {
    return {
      type: "invoice",
      externalId: String(body.external_id),
      invoiceId: body.id || null,
      status: String(body.status).toUpperCase(),
      method: body.payment_channel || body.payment_method || "",
      paidAmount: Number(body.paid_amount || body.amount || 0),
      currency: body.currency || null,
    };
  }
  return null;
}

module.exports = {
  isConfigured,
  createSubAccount,
  getSubAccount,
  splitRuleFor,
  createInvoice,
  createPayout,
  verifyCallback,
  parseCallback,
  roundFor,
  _errText: errText,
  _clearCache: () => splitRuleCache.clear(),
};
