const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const Subscription = require("../models/Subscription");
const jazzcashService = require("../services/payments/jazzcashService");
const easypaisaService = require("../services/payments/easypaisaService");
const xenditService = require("../services/payments/xenditService");
const lemonSqueezyService = require("../services/payments/lemonSqueezyService");
const lsConfig = require("../config/lemonSqueezy");
const { sendInvoiceEmail } = require("../services/emailService");
const { v4: uuidv4 } = require("uuid");
const moment = require("moment");
const logger = require("../utils/logger");
const {
  PLANS,
  PLAN_PRICES,
  PLAN_USD_PRICES,
  PLAN_KEYS_FOR_ENUM,
  resolvePlanId,
  getPlan,
} = require("../config/plans");

const MESSAGE_LIMITS = Object.fromEntries(
  Object.values(PLANS).map((p) => [
    p.id,
    p.limits?.messages === -1 ? Infinity : p.limits?.messages || 0,
  ]),
);

const PUBLIC_PLAN_IDS = ["ig_starter", "ig_pro"];

// @GET /api/billing/plans — Get available plans (channel-grouped)
const getPlans = asyncHandler(async (req, res) => {
  const plans = PUBLIC_PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      key: p.id,
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      channel: p.channel,
      monthlyPrice: p.priceMonthly,
      annualPrice: p.priceAnnual,
      currency: p.currency,
      usd: p.usd,
      trialDays: p.trialDays || 0,
      limits: p.limits,
      highlights: p.highlights || [],
      features: p.features || [],
      recommended: !!p.recommended,
      premium: !!p.premium,
    };
  });
  res.json({ success: true, plans });
});

// @GET /api/billing/subscription — Get current subscription
const getSubscription = asyncHandler(async (req, res) => {
  const subscription = await Subscription.findOne({
    workspaceId: req.workspace._id,
  }).populate("latestInvoiceId");
  const workspace = req.workspace;

  res.json({
    success: true,
    subscription,
    usage: workspace.usage,
    planLimits: workspace.getPlanLimits(),
  });
});

// @GET /api/billing/invoices — Get invoice history
const getInvoices = asyncHandler(async (req, res) => {
  const mongoose = require("mongoose");
  const Invoice = mongoose.model("Invoice");
  const invoices = await Invoice.find({ workspaceId: req.workspace._id })
    .sort({ createdAt: -1 })
    .limit(24);
  res.json({ success: true, invoices });
});

// @POST /api/billing/initiate — Start payment flow
const initiatePayment = asyncHandler(async (req, res) => {
  const {
    plan,
    billingCycle = "monthly",
    paymentMethod,
    mobileNumber,
  } = req.body;
  if (!plan || !paymentMethod) {
    res.status(400);
    throw new Error("Plan and payment method required");
  }
  const planId = resolvePlanId(plan);
  if (!PUBLIC_PLAN_IDS.includes(planId)) {
    res.status(400);
    throw new Error("Invalid plan");
  }
  if (planId === "free") {
    res.status(400);
    throw new Error("Free trial does not require payment");
  }

  const prices = PLAN_PRICES[planId];
  const amount = prices?.[billingCycle] ?? prices?.monthly;
  if (!amount) {
    res.status(400);
    throw new Error("Plan pricing unavailable");
  }
  const txnRef = `BL-${uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase()}`;

  // ── Card subscription via Xendit (auto-recurring) ──────────────────────────
  if (paymentMethod === "card" || paymentMethod === "xendit") {
    if (!xenditService.isConfigured()) {
      res.status(503);
      throw new Error("Card payments are not configured yet");
    }
    const usd = PLAN_USD_PRICES[planId]?.[billingCycle];
    if (!usd) {
      res.status(400);
      throw new Error("USD pricing unavailable for this plan");
    }

    const clientUrl = process.env.CLIENT_URL || "https://botlify.site";
    const successUrl =
      process.env.XENDIT_SUCCESS_URL ||
      `${clientUrl}/dashboard/billing?billing=success`;
    const failureUrl =
      process.env.XENDIT_FAILURE_URL ||
      `${clientUrl}/dashboard/billing?billing=failed`;

    const checkout = await xenditService.createSubscriptionCheckout({
      referenceId: txnRef,
      amount: usd,
      currency: "USD",
      billingCycle,
      customer: {
        referenceId: String(req.workspace._id),
        email: req.user?.email,
        name: req.user?.name,
      },
      description: `Botlify ${planId} (${billingCycle})`,
      successUrl,
      failureUrl,
      metadata: {
        workspaceId: String(req.workspace._id),
        plan: planId,
        billingCycle,
      },
    });

    // Record a pending subscription so the webhook can resolve the workspace.
    await Subscription.findOneAndUpdate(
      { workspaceId: req.workspace._id },
      {
        plan: planId,
        billingCycle,
        status: "trialing",
        amount: usd,
        currency: "USD",
        provider: "xendit",
        paymentMethod: "card",
        xenditReferenceId: txnRef,
        xenditCustomerId: String(req.workspace._id),
        xenditSessionId: checkout.sessionId,
      },
      { upsert: true, new: true },
    );

    return res.json({
      success: true,
      redirectUrl: checkout.url,
      txnRef,
      amount: usd,
      currency: "USD",
      plan,
      billingCycle,
      message: "Redirecting to secure card checkout…",
    });
  }

  let result;
  if (paymentMethod === "jazzcash") {
    if (!mobileNumber) {
      res.status(400);
      throw new Error("Mobile number required for JazzCash");
    }
    result = await jazzcashService.initiatePayment({
      mobileNumber,
      amountPKR: amount,
      txnRefNo: txnRef,
      description: `Velox-Whatbot ${plan} plan`,
    });
  } else if (paymentMethod === "easypaisa") {
    if (!mobileNumber) {
      res.status(400);
      throw new Error("Mobile number required for EasyPaisa");
    }
    result = await easypaisaService.initiatePayment({
      mobileNumber,
      amountPKR: amount,
      orderRefNum: txnRef,
      description: `Velox-Whatbot ${plan} plan`,
    });
  } else {
    res.status(400);
    throw new Error("Unsupported payment method for now");
  }

  res.json({
    success: true,
    result,
    txnRef,
    amount,
    plan,
    billingCycle,
    message: result.success
      ? "Payment initiated. Check your mobile wallet app."
      : `Payment initiation failed: ${result.error || result.responseMessage}`,
  });
});

// @POST /api/billing/confirm — Confirm payment and activate plan
const confirmPayment = asyncHandler(async (req, res) => {
  const {
    txnRef,
    plan,
    billingCycle = "monthly",
    paymentMethod,
    responseCode,
  } = req.body;

  // Verify with payment provider
  let verified = false;
  if (paymentMethod === "jazzcash") {
    const check = await jazzcashService.verifyTransaction(txnRef);
    verified = check.success;
  } else if (paymentMethod === "easypaisa") {
    const check = await easypaisaService.checkStatus(txnRef);
    verified = check.success;
  }

  // For sandbox/test: accept 000 response code as success
  if (
    !verified &&
    (responseCode === "000" || responseCode === "0000") &&
    process.env.NODE_ENV !== "production"
  ) {
    verified = true;
  }

  if (!verified) {
    res.status(400);
    throw new Error("Payment verification failed");
  }

  await activatePlan({
    workspaceId: req.workspace._id,
    plan: resolvePlanId(plan),
    billingCycle,
    paymentMethod,
    txnRef,
    amount: PLAN_PRICES[resolvePlanId(plan)]?.[billingCycle],
  });

  res.json({ success: true, message: `${plan} plan activated successfully!` });
});

// Internal: Activate a plan after successful payment
const activatePlan = async ({
  workspaceId,
  plan,
  billingCycle,
  paymentMethod,
  txnRef,
  amount,
  currency = "PKR",
  provider,
  resetUsage = true,
  extra = {},
}) => {
  const now = new Date();
  const periodEnd =
    billingCycle === "annual"
      ? moment().add(1, "year").toDate()
      : moment().add(1, "month").toDate();
  const messagesLimit = MESSAGE_LIMITS[plan];
  const numericLimit = messagesLimit === Infinity ? -1 : messagesLimit || 0;

  const wsUpdate = {
    "subscription.plan": plan,
    "subscription.status": "active",
    "subscription.currentPeriodStart": now,
    "subscription.currentPeriodEnd": periodEnd,
    "usage.messagesLimit": numericLimit,
  };
  // On renewals we keep the running usage; only reset on a fresh activation.
  if (resetUsage) {
    wsUpdate["usage.messagesThisMonth"] = 0;
    wsUpdate["usage.lastResetDate"] = now;
  }
  await Workspace.findByIdAndUpdate(workspaceId, wsUpdate);

  await Subscription.findOneAndUpdate(
    { workspaceId },
    {
      plan,
      billingCycle,
      status: "active",
      amount,
      currency,
      ...(provider ? { provider } : {}),
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      paymentMethod,
      lastPaymentDate: now,
      lastPaymentAmount: amount,
      lastPaymentStatus: "paid",
      nextBillingDate: periodEnd,
      transactionId: txnRef,
      ...extra,
    },
    { upsert: true, new: true },
  );
};

// @POST /api/billing/webhook/xendit — Xendit recurring webhooks (public).
// Verified via the static x-callback-token header. Idempotent: Xendit may
// re-deliver, and activatePlan is safe to run more than once per cycle.
const handleXenditWebhook = asyncHandler(async (req, res) => {
  if (!xenditService.verifyWebhook(req)) {
    logger.warn("[Xendit webhook] invalid callback token — dropping");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast

  const body = req.body || {};
  const event = (body.event || body.type || "").toLowerCase();
  const data = body.data || body;
  const meta = data.metadata || body.metadata || {};
  const referenceId =
    data.reference_id || data.plan_reference_id || body.reference_id;

  logger.info(`[Xendit webhook] event=${event} ref=${referenceId}`);

  // Resolve the workspace: prefer metadata, fall back to the pending sub row.
  let sub = null;
  if (meta.workspaceId) {
    sub = await Subscription.findOne({ workspaceId: meta.workspaceId });
  }
  if (!sub && referenceId) {
    sub = await Subscription.findOne({ xenditReferenceId: referenceId });
  }
  if (!sub) {
    logger.warn(`[Xendit webhook] no subscription matched (ref=${referenceId})`);
    return;
  }

  const plan = resolvePlanId(meta.plan || sub.plan);
  const billingCycle = meta.billingCycle || sub.billingCycle || "monthly";
  const planId =
    data.plan_id || data.recurring_plan_id || data.id || sub.xenditPlanId;

  if (
    event.includes("plan.activated") ||
    event.includes("plan_activated") ||
    event.includes("recurring_plan.activated")
  ) {
    await Subscription.updateOne(
      { _id: sub._id },
      { provider: "xendit", xenditPlanId: planId, status: "active" },
    );
    return;
  }

  if (event.includes("cycle.succeeded") || event.includes("payment.succeeded")) {
    // First charge OR a renewal — (re)activate and extend the period.
    await activatePlan({
      workspaceId: sub.workspaceId,
      plan,
      billingCycle,
      paymentMethod: "card",
      provider: "xendit",
      txnRef: data.action_id || data.id || sub.xenditReferenceId,
      amount: sub.amount,
      currency: sub.currency || "USD",
      resetUsage: true,
      extra: planId ? { xenditPlanId: planId } : {},
    });
    return;
  }

  if (event.includes("cycle.retrying")) {
    await Subscription.updateOne({ _id: sub._id }, { status: "past_due" });
    return;
  }

  if (
    event.includes("cycle.failed") ||
    event.includes("plan.inactivated") ||
    event.includes("payment.failed")
  ) {
    // All retries failed — suspend and drop the workspace back to free limits.
    await Subscription.updateOne(
      { _id: sub._id },
      { status: "suspended", lastPaymentStatus: "failed" },
    );
    await Workspace.findByIdAndUpdate(sub.workspaceId, {
      "subscription.status": "past_due",
    });
    return;
  }
});

// @POST /api/billing/cancel — Cancel subscription
const cancelSubscription = asyncHandler(async (req, res) => {
  const sub = await Subscription.findOne({ workspaceId: req.workspace._id });

  // Stop future auto-charges on the gateway side for card subscriptions.
  if (sub?.provider === "xendit" && sub.xenditPlanId) {
    await xenditService.deactivatePlan(sub.xenditPlanId).catch(() => {});
  }
  if (sub?.provider === "lemonsqueezy" && sub.lemonSqueezySubscriptionId) {
    await lemonSqueezyService
      .cancelSubscription(sub.lemonSqueezySubscriptionId)
      .catch((e) => logger.warn("[LS] cancel API failed", { err: e.message }));
  }

  await Subscription.findOneAndUpdate(
    { workspaceId: req.workspace._id },
    { cancelAtPeriodEnd: true, cancelledAt: new Date() },
  );
  await Workspace.findByIdAndUpdate(req.workspace._id, {
    "subscription.cancelAtPeriodEnd": true,
  });
  res.json({
    success: true,
    message:
      "Subscription will be cancelled at the end of your billing period.",
  });
});

// ─── Lemon Squeezy (Merchant-of-Record, card subscriptions) ─────────────────

// @POST /api/billing/lemonsqueezy/checkout — owner starts a subscription.
// Body: { plan, billingCycle }. Returns a hosted checkout URL to redirect to.
const createLemonCheckout = asyncHandler(async (req, res) => {
  if (!lsConfig.isConfigured()) {
    res.status(503);
    throw new Error("Card payments are not configured yet.");
  }
  const { plan, billingCycle = "monthly" } = req.body;
  const planId = resolvePlanId(plan);
  if (!PUBLIC_PLAN_IDS.includes(planId)) {
    res.status(400);
    throw new Error("Invalid plan");
  }
  const cycle = billingCycle === "annual" ? "annual" : "monthly";
  const variantId = lsConfig.getVariantId(planId, cycle);
  if (!variantId) {
    res.status(503);
    throw new Error(
      "This plan isn't available for checkout yet. Please contact support.",
    );
  }

  const clientUrl = process.env.CLIENT_URL || "https://www.botlify.site";
  const url = await lemonSqueezyService.createCheckout({
    variantId,
    email: req.user.email,
    name: req.user.name,
    workspaceId: req.workspace._id,
    userId: req.user._id,
    plan: planId,
    cycle,
    redirectUrl: `${clientUrl}/dashboard/billing?checkout=success`,
  });

  res.json({ success: true, url });
});

// @GET /api/billing/lemonsqueezy/portal — owner opens the LS customer portal
// (update card, cancel, download invoices).
const getBillingPortal = asyncHandler(async (req, res) => {
  const sub = await Subscription.findOne({ workspaceId: req.workspace._id });
  if (!sub?.lemonSqueezySubscriptionId) {
    res.status(404);
    throw new Error("No active card subscription to manage.");
  }
  const url = await lemonSqueezyService.getCustomerPortalUrl(
    sub.lemonSqueezySubscriptionId,
  );
  if (!url) {
    res.status(502);
    throw new Error("Could not open the billing portal. Try again shortly.");
  }
  res.json({ success: true, url });
});

// @POST /api/billing/lemonsqueezy/webhook — LS posts subscription lifecycle
// events here. Public; verified via HMAC signature over the RAW body.
// req.body is a Buffer (express.raw is applied to this path in server.js).
const handleLemonSqueezyWebhook = asyncHandler(async (req, res) => {
  const raw = req.body; // Buffer
  const signature = req.headers["x-signature"];
  if (!lemonSqueezyService.verifyWebhookSignature(raw, signature)) {
    logger.warn("[LS webhook] invalid signature — dropping");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast; process below

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    logger.warn("[LS webhook] unparseable body");
    return;
  }

  const eventName = payload?.meta?.event_name;
  const custom = payload?.meta?.custom_data || {};
  const attrs = payload?.data?.attributes || {};
  const subId = payload?.data?.id;
  const workspaceId = custom.workspace_id;
  const variantId = attrs.variant_id || attrs.first_subscription_item?.variant_id;

  logger.info(`[LS webhook] event=${eventName} ws=${workspaceId} sub=${subId}`);

  if (!workspaceId) {
    logger.warn("[LS webhook] no workspace_id in custom_data — skipping");
    return;
  }

  // Figure out which plan/cycle this is (prefer explicit custom_data).
  const mapped = lsConfig.planForVariant(variantId) || {};
  const plan = resolvePlanId(custom.plan || mapped.plan || "");
  const variantName = (attrs.variant_name || "").toLowerCase();
  const cycle =
    custom.cycle ||
    mapped.cycle ||
    (variantName.includes("year") || variantName.includes("annual")
      ? "annual"
      : "monthly");

  try {
    switch (eventName) {
      case "subscription_created":
      case "subscription_updated":
      case "subscription_resumed":
      case "subscription_unpaused": {
        const status = attrs.status; // active | on_trial | paused | cancelled | expired | past_due | unpaid
        if (["active", "on_trial", "paused"].includes(status)) {
          await activatePlan({
            workspaceId,
            plan,
            billingCycle: cycle,
            paymentMethod: "card",
            provider: "lemonsqueezy",
            txnRef: subId,
            amount: PLAN_USD_PRICES[plan]?.[cycle] || 0,
            currency: "USD",
            resetUsage: eventName === "subscription_created",
            extra: {
              lemonSqueezySubscriptionId: subId,
              lemonSqueezyCustomerId: String(attrs.customer_id || ""),
              lemonSqueezyOrderId: String(attrs.order_id || ""),
              lemonSqueezyVariantId: String(variantId || ""),
              status: status === "on_trial" ? "trialing" : "active",
              trialEndsAt: attrs.trial_ends_at
                ? new Date(attrs.trial_ends_at)
                : undefined,
            },
          });
          // Mirror trial/renewal dates + LS id + status onto the workspace.
          await Workspace.findByIdAndUpdate(workspaceId, {
            "subscription.status":
              status === "on_trial" ? "trialing" : "active",
            "subscription.provider": "lemonsqueezy",
            "subscription.billingCycle": cycle,
            "subscription.lemonSqueezySubscriptionId": subId,
            "subscription.cancelAtPeriodEnd": !!attrs.cancelled,
            ...(attrs.trial_ends_at
              ? { "subscription.trialEndsAt": new Date(attrs.trial_ends_at) }
              : {}),
            ...(attrs.renews_at
              ? { "subscription.currentPeriodEnd": new Date(attrs.renews_at) }
              : {}),
          });
        } else if (["cancelled", "expired", "unpaid"].includes(status)) {
          await downgradeToTrial(workspaceId, subId);
        } else if (status === "past_due") {
          await Workspace.findByIdAndUpdate(workspaceId, {
            "subscription.status": "past_due",
          });
          await Subscription.findOneAndUpdate(
            { workspaceId },
            { status: "past_due" },
          );
        }
        break;
      }

      case "subscription_cancelled": {
        // Cancelled but usually still active until period end.
        await Subscription.findOneAndUpdate(
          { workspaceId },
          { cancelAtPeriodEnd: true, cancelledAt: new Date() },
        );
        await Workspace.findByIdAndUpdate(workspaceId, {
          "subscription.cancelAtPeriodEnd": true,
        });
        break;
      }

      case "subscription_expired": {
        await downgradeToTrial(workspaceId, subId);
        break;
      }

      case "subscription_payment_success": {
        await Subscription.findOneAndUpdate(
          { workspaceId },
          {
            lastPaymentDate: new Date(),
            lastPaymentStatus: "paid",
            status: "active",
          },
        );
        break;
      }

      case "subscription_payment_failed": {
        await Subscription.findOneAndUpdate(
          { workspaceId },
          { lastPaymentStatus: "failed", status: "past_due" },
        );
        await Workspace.findByIdAndUpdate(workspaceId, {
          "subscription.status": "past_due",
        });
        break;
      }

      default:
        logger.info(`[LS webhook] ignored event ${eventName}`);
    }
  } catch (err) {
    logger.error("[LS webhook] processing error", { err: err.message });
  }
});

// When a subscription truly ends, drop the workspace back to the (locked) trial
// state so paid features gate off.
async function downgradeToTrial(workspaceId, subId) {
  await Workspace.findByIdAndUpdate(workspaceId, {
    "subscription.plan": "free",
    "subscription.status": "cancelled",
    "subscription.cancelAtPeriodEnd": false,
  });
  await Subscription.findOneAndUpdate(
    { workspaceId, ...(subId ? { lemonSqueezySubscriptionId: subId } : {}) },
    { status: "cancelled", cancelledAt: new Date() },
  );
  logger.info(`[LS] workspace ${workspaceId} downgraded (subscription ended)`);
}

// @POST /api/billing/select-plan — Directly activate a plan (no payment required).
// Used during testing / manual upgrades before card payment is live.
const selectPlan = asyncHandler(async (req, res) => {
  const { plan, billingCycle = "monthly" } = req.body;
  if (!plan) {
    res.status(400);
    throw new Error("Plan is required");
  }
  const planId = resolvePlanId(plan);
  if (!PUBLIC_PLAN_IDS.includes(planId)) {
    res.status(400);
    throw new Error("Invalid plan");
  }

  await activatePlan({
    workspaceId: req.workspace._id,
    plan: planId,
    billingCycle,
    paymentMethod: "manual",
    txnRef: `MANUAL-${Date.now()}`,
    amount: PLAN_PRICES[planId]?.[billingCycle] || 0,
  });

  res.json({
    success: true,
    message: `Plan changed to ${planId} successfully!`,
  });
});

module.exports = {
  getPlans,
  getSubscription,
  getInvoices,
  initiatePayment,
  confirmPayment,
  cancelSubscription,
  selectPlan,
  handleXenditWebhook,
  createLemonCheckout,
  getBillingPortal,
  handleLemonSqueezyWebhook,
};
