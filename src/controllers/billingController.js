const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const Subscription = require("../models/Subscription");
const jazzcashService = require("../services/payments/jazzcashService");
const easypaisaService = require("../services/payments/easypaisaService");
const { sendInvoiceEmail } = require("../services/emailService");
const { v4: uuidv4 } = require("uuid");
const moment = require("moment");

const PLAN_PRICES = {
  starter: { monthly: 0, annual: 0 },
  growth: { monthly: 2999, annual: 2999 * 10 },
  business: { monthly: 6999, annual: 6999 * 10 },
  agency: { monthly: 14999, annual: 14999 * 10 },
};

const MESSAGE_LIMITS = {
  starter: 500,
  growth: 5000,
  business: 20000,
  agency: 50000,
};

// @GET /api/billing/plans — Get available plans
const getPlans = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    plans: [
      {
        key: "starter",
        name: "Starter",
        monthlyPrice: 0,
        annualPrice: 0,
        messages: 500,
        contacts: 50,
        flows: 3,
        numbers: 1,
        features: [
          "500 messages/mo",
          "50 contacts",
          "3 automation flows",
          "UltraMsg QR connection",
          "Basic inbox",
          "Community support",
        ],
      },
      {
        key: "growth",
        name: "Growth",
        monthlyPrice: 2999,
        annualPrice: 2999 * 10,
        messages: 5000,
        contacts: 500,
        flows: -1,
        numbers: 1,
        features: [
          "5,000 messages/mo",
          "500 contacts",
          "Unlimited flows",
          "Meta Cloud API (official)",
          "Full inbox + handover",
          "WhatsApp broadcasts (add-on)",
          "90-day analytics",
          "Email support (48hr)",
        ],
      },
      {
        key: "business",
        name: "Business",
        monthlyPrice: 6999,
        annualPrice: 6999 * 10,
        messages: 20000,
        contacts: -1,
        flows: -1,
        numbers: 3,
        features: [
          "20,000 messages/mo",
          "Unlimited contacts",
          "3 WhatsApp numbers",
          "Meta / 360dialog",
          "20,000 broadcast msgs/mo",
          "1-year analytics",
          "Zapier + Webhooks",
          "Priority email support",
        ],
      },
      {
        key: "agency",
        name: "Agency",
        monthlyPrice: 14999,
        annualPrice: 14999 * 10,
        messages: 50000,
        contacts: -1,
        flows: -1,
        numbers: 10,
        features: [
          "50,000 messages/mo",
          "10 client workspaces",
          "White-label option",
          "Full REST API",
          "50,000 broadcasts/mo",
          "Dedicated account manager",
        ],
      },
    ],
  });
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
  if (!["starter", "growth", "business", "agency"].includes(plan)) {
    res.status(400);
    throw new Error("Invalid plan");
  }
  if (plan === "starter") {
    res.status(400);
    throw new Error("Starter plan is free — no payment required");
  }

  const amount = PLAN_PRICES[plan][billingCycle];
  const txnRef = `VW-${uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase()}`;

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
    plan,
    billingCycle,
    paymentMethod,
    txnRef,
    amount: PLAN_PRICES[plan][billingCycle],
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

  await Workspace.findByIdAndUpdate(workspaceId, {
    "subscription.plan": plan,
    "subscription.status": "active",
    "subscription.currentPeriodStart": now,
    "subscription.currentPeriodEnd": periodEnd,
    "usage.messagesLimit": MESSAGE_LIMITS[plan],
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

module.exports = {
  getPlans,
  getSubscription,
  getInvoices,
  initiatePayment,
  confirmPayment,
  cancelSubscription,
};
