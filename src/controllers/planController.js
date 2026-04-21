/**
 * Botlify — Plan controller
 * Click-to-activate: no payment gateway yet.
 */
const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const { PLANS, getPlan } = require("../config/plans");

// GET /api/plans — public list
exports.listPlans = asyncHandler(async (_req, res) => {
  res.json({ plans: Object.values(PLANS) });
});

// GET /api/plans/current — workspace's current plan
exports.getCurrentPlan = asyncHandler(async (req, res) => {
  const ws = req.workspace;
  const planId = ws.subscription?.plan || "starter";
  res.json({
    plan: getPlan(planId),
    usage: ws.usage || {},
    subscription: ws.subscription || {},
  });
});

// POST /api/plans/activate — click-to-activate (no payment)
exports.activatePlan = asyncHandler(async (req, res) => {
  const { planId } = req.body;
  if (!PLANS[planId]) {
    return res.status(400).json({ error: "Invalid plan" });
  }
  const plan = PLANS[planId];

  const update = {
    "subscription.plan": planId,
    "subscription.status": "active",
    "subscription.activatedAt": new Date(),
    "subscription.currentPeriodEnd": new Date(Date.now() + 30 * 86400000),
    "usage.messagesLimit":
      plan.limits.dmsPerMonth === -1 ? 999999999 : plan.limits.dmsPerMonth,
  };
  // Disable AI bot if downgrading
  if (!plan.features.includes("ai_bot")) {
    update["aiBot.enabled"] = false;
  }
  // Force Botlify branding on Starter
  if (!plan.features.includes("remove_branding")) {
    update["settings.botlifyBrandingEnabled"] = true;
  }

  const workspace = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    { $set: update },
    { new: true },
  );
  res.json({ success: true, plan, workspace });
});
