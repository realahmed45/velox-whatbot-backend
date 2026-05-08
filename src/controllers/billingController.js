const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const Subscription = require("../models/Subscription");
const jazzcashService = require("../services/payments/jazzcashService");
const easypaisaService = require("../services/payments/easypaisaService");
const { sendInvoiceEmail } = require("../services/emailService");
const { v4: uuidv4 } = require("uuid");
const moment = require("moment");
const {
  PLANS,
  PLAN_PRICES,
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

const PUBLIC_PLAN_IDS = [
  "ig_starter",
  "wa_starter",
  "bundle_pro",
  "bundle_business",
];

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
}) => {
  const now = new Date();
  const periodEnd =
    billingCycle === "annual"
      ? moment().add(1, "year").toDate()
      : moment().add(1, "month").toDate();
  const messagesLimit = MESSAGE_LIMITS[plan];
  const numericLimit = messagesLimit === Infinity ? -1 : messagesLimit || 0;

  await Workspace.findByIdAndUpdate(workspaceId, {
    "subscription.plan": plan,
    "subscription.status": "active",
    "subscription.currentPeriodStart": now,
    "subscription.currentPeriodEnd": periodEnd,
    "usage.messagesLimit": numericLimit,
    "usage.messagesThisMonth": 0,
    "usage.lastResetDate": now,
  });

  await Subscription.findOneAndUpdate(
    { workspaceId },
    {
      plan,
      billingCycle,
      status: "active",
      amount,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      paymentMethod,
      lastPaymentDate: now,
      lastPaymentAmount: amount,
      lastPaymentStatus: "paid",
      nextBillingDate: periodEnd,
      transactionId: txnRef,
    },
    { upsert: true, new: true },
  );
};

// @POST /api/billing/cancel — Cancel subscription
const cancelSubscription = asyncHandler(async (req, res) => {
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
};
