/**
 * Admin controller — powers the Botlify admin panel (/admin).
 *
 * Auth is a single env-based email+password pair (see middleware/adminAuth).
 * These endpoints give the founder a read-only overview: platform stats, the
 * user list, and active subscriptions. No mutation of customer data here.
 */
const asyncHandler = require("express-async-handler");
const User = require("../models/User");
const Workspace = require("../models/Workspace");
const Subscription = require("../models/Subscription");
const AdminEvent = require("../models/AdminEvent");

// Derive a single funnel stage for a workspace, most-advanced first.
const funnelStage = (ws) => {
  const sub = ws?.subscription || {};
  const ig = ws?.instagram || {};
  // Lifetime always wins.
  if (sub.lifetime === true) return "lifetime";
  // Truly paying = active AND not scheduled to cancel.
  if (sub.status === "active" && sub.plan && sub.plan !== "free") {
    return sub.cancelAtPeriodEnd ? "canceling" : "paying";
  }
  if (["cancelled", "expired", "past_due"].includes(sub.status))
    return "cancelled";
  if (sub.status === "trialing") return "trial";
  if (ig.status === "connected") return "connected";
  if ((ws?.aiKnowledge?.sources || []).length > 0) return "knowledge";
  if (ws?.onboardingCompleted) return "onboarded";
  return "signed_up";
};
const {
  checkAdminCredentials,
  signAdminToken,
  isAdminConfigured,
} = require("../middleware/adminAuth");

// @POST /api/admin/login  { email, password } -> { token }
const login = asyncHandler(async (req, res) => {
  if (!isAdminConfigured()) {
    res.status(503);
    throw new Error(
      "Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.",
    );
  }
  const { email, password } = req.body;
  if (!checkAdminCredentials(email, password)) {
    res.status(401);
    throw new Error("Invalid admin credentials");
  }
  res.json({ success: true, token: signAdminToken() });
});

// @GET /api/admin/overview -> headline stats
const overview = asyncHandler(async (req, res) => {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    usersToday,
    usersThisWeek,
    verifiedUsers,
    totalWorkspaces,
    connectedWorkspaces,
    activeSubs,
    trialingSubs,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ createdAt: { $gte: dayAgo } }),
    User.countDocuments({ createdAt: { $gte: weekAgo } }),
    User.countDocuments({ isEmailVerified: true }),
    Workspace.countDocuments(),
    Workspace.countDocuments({ "instagram.status": "connected" }),
    Workspace.countDocuments({ "subscription.status": "active" }),
    Workspace.countDocuments({ "subscription.status": "trialing" }),
  ]);

  // Rough MRR from active subscriptions (in their stored currency; USD-ish).
  const activeSubDocs = await Subscription.find({ status: "active" })
    .select("amount currency billingCycle plan")
    .lean();
  let mrr = 0;
  for (const s of activeSubDocs) {
    const monthly =
      s.billingCycle === "annual" ? (s.amount || 0) / 12 : s.amount || 0;
    mrr += monthly;
  }

  // Funnel counts across all workspaces.
  const [onboardedWs, knowledgeWs, lifetimeWs] = await Promise.all([
    Workspace.countDocuments({ onboardingCompleted: true }),
    Workspace.countDocuments({ "aiKnowledge.sources.0": { $exists: true } }),
    Workspace.countDocuments({ "subscription.lifetime": true }),
  ]);

  res.json({
    users: {
      total: totalUsers,
      today: usersToday,
      thisWeek: usersThisWeek,
      verified: verifiedUsers,
    },
    workspaces: {
      total: totalWorkspaces,
      igConnected: connectedWorkspaces,
      onboarded: onboardedWs,
      addedKnowledge: knowledgeWs,
    },
    subscriptions: {
      active: activeSubs,
      trialing: trialingSubs,
      lifetime: lifetimeWs,
      paying: activeSubs + lifetimeWs,
      estimatedMrr: Math.round(mrr),
    },
    // Conversion funnel (each stage as a count).
    funnel: {
      signedUp: totalUsers,
      onboarded: onboardedWs,
      connectedIg: connectedWorkspaces,
      addedKnowledge: knowledgeWs,
      onTrial: trialingSubs,
      paying: activeSubs + lifetimeWs,
    },
    generatedAt: now,
  });
});

// @GET /api/admin/activity?limit=&page=&q=&stage= -> users enriched with their
// workspace funnel stage + activity details. This is the main "trace every
// user" table.
const listActivity = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const q = (req.query.q || "").trim();
  const stage = (req.query.stage || "").trim();

  const filter = q
    ? {
        $or: [
          { email: { $regex: q, $options: "i" } },
          { name: { $regex: q, $options: "i" } },
        ],
      }
    : {};

  const users = await User.find(filter)
    .select("name email isEmailVerified signupNumber googleId createdAt lastLogin")
    .sort({ createdAt: -1 })
    .lean();

  // Owned workspace per user (the primary one), with all activity fields.
  const userIds = users.map((u) => u._id);
  const workspaces = await Workspace.find({ owner: { $in: userIds } })
    .select(
      "owner name subscription instagram onboardingCompleted aiKnowledge.sources aiSettings.enabled usage aiStats createdAt",
    )
    .lean();
  const wsByOwner = {};
  for (const w of workspaces) {
    // keep the most recently created workspace per owner
    const k = String(w.owner);
    if (!wsByOwner[k] || w.createdAt > wsByOwner[k].createdAt) wsByOwner[k] = w;
  }

  let rows = users.map((u) => {
    const w = wsByOwner[String(u._id)] || null;
    const ig = w?.instagram || {};
    const sub = w?.subscription || {};
    return {
      userId: u._id,
      signupNumber: u.signupNumber,
      name: u.name,
      email: u.email,
      verified: !!u.isEmailVerified,
      signupMethod: u.googleId ? "google" : "email",
      signedUpAt: u.createdAt,
      lastLogin: u.lastLogin || null,
      stage: funnelStage(w),
      onboarded: !!w?.onboardingCompleted,
      ig: {
        connected: ig.status === "connected",
        username: ig.username || null,
        followers: ig.followersCount || 0,
        connectedAt: ig.connectedAt || null,
        lastMessageAt: ig.lastMessageAt || null,
      },
      plan: sub.plan || "free",
      subStatus: sub.status || null,
      lifetime: sub.lifetime === true,
      trialEndsAt: sub.trialEndsAt || null,
      knowledgeSources: (w?.aiKnowledge?.sources || []).length,
      aiEnabled: w?.aiSettings?.enabled !== false,
      messagesThisMonth: w?.usage?.messagesThisMonth || 0,
      aiRepliesThisMonth: w?.aiStats?.repliesThisMonth || 0,
      leadsCaptured: w?.aiStats?.leadsCaptured || 0,
      workspaceName: w?.name || null,
    };
  });

  if (stage) rows = rows.filter((r) => r.stage === stage);

  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit);
  res.json({
    rows: paged,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  });
});

// @GET /api/admin/timeline?limit=&type= -> the live activity feed (newest first)
const timeline = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const type = (req.query.type || "").trim();
  const filter = type ? { type } : {};
  const events = await AdminEvent.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ events, total: events.length });
});

// @GET /api/admin/users?limit=&page=&q= -> paginated users
const listUsers = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const q = (req.query.q || "").trim();

  const filter = q
    ? {
        $or: [
          { email: { $regex: q, $options: "i" } },
          { name: { $regex: q, $options: "i" } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    User.find(filter)
      .select(
        "name email isEmailVerified signupNumber role createdAt lastLogin",
      )
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  res.json({ users, total, page, limit, pages: Math.ceil(total / limit) });
});

// @GET /api/admin/subscriptions -> workspaces with their plan/status
const listSubscriptions = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const workspaces = await Workspace.find({
    "subscription.plan": { $ne: "free" },
  })
    .select("name slug subscription instagram.username createdAt")
    .sort({ "subscription.currentPeriodStart": -1, createdAt: -1 })
    .limit(limit)
    .lean();

  const rows = workspaces.map((w) => ({
    id: w._id,
    name: w.name,
    igUsername: w.instagram?.username || null,
    plan: w.subscription?.plan,
    status: w.subscription?.status,
    provider: w.subscription?.provider,
    billingCycle: w.subscription?.billingCycle,
    currentPeriodEnd: w.subscription?.currentPeriodEnd,
    createdAt: w.createdAt,
  }));

  res.json({ subscriptions: rows, total: rows.length });
});

// ── Consultants & commissions (hotel product) ───────────────────────────────
const Consultant = require("../models/Consultant");
const CommissionEntry = require("../models/CommissionEntry");

const round2 = (n) => Math.round(n * 100) / 100;

// @GET /api/admin/consultants -> all consultants + per-currency earning sums
const listConsultants = asyncHandler(async (req, res) => {
  const consultants = await Consultant.find()
    .populate("userId", "name email")
    .sort({ createdAt: -1 })
    .lean();

  // One aggregate for every consultant's share ledger, folded per currency.
  const sums = await CommissionEntry.aggregate([
    { $match: { kind: "consultant_share" } },
    {
      $group: {
        _id: {
          consultantId: "$consultantId",
          currency: "$currency",
          status: "$status",
        },
        total: { $sum: "$amount" },
      },
    },
  ]);
  const byConsultant = {};
  for (const row of sums) {
    const cid = String(row._id.consultantId);
    const cur = row._id.currency || "USD";
    byConsultant[cid] = byConsultant[cid] || {};
    byConsultant[cid][cur] = byConsultant[cid][cur] || {
      currency: cur,
      accrued: 0,
      verified: 0,
      paid: 0,
    };
    const bucket = byConsultant[cid][cur];
    if (row._id.status === "accrued") bucket.accrued += row.total;
    else if (["verified", "invoiced"].includes(row._id.status))
      bucket.verified += row.total;
    else if (row._id.status === "paid") bucket.paid += row.total;
  }

  const rows = consultants.map((c) => ({
    ...c,
    earnings: Object.values(byConsultant[String(c._id)] || {}).map((e) => ({
      currency: e.currency,
      accrued: round2(e.accrued),
      verified: round2(e.verified),
      paid: round2(e.paid),
    })),
  }));

  res.json({ consultants: rows, total: rows.length });
});

// @POST /api/admin/consultants/:id/approve
const approveConsultant = asyncHandler(async (req, res) => {
  const consultant = await Consultant.findById(req.params.id);
  if (!consultant) {
    res.status(404);
    throw new Error("Consultant not found");
  }
  consultant.status = "approved";
  consultant.approvedAt = new Date();
  consultant.approvedBy = req.admin?.email || "";
  consultant.suspendedReason = "";
  await consultant.save();
  res.json({ success: true, consultant });
});

// @POST /api/admin/consultants/:id/suspend  { reason }
const suspendConsultant = asyncHandler(async (req, res) => {
  const consultant = await Consultant.findById(req.params.id);
  if (!consultant) {
    res.status(404);
    throw new Error("Consultant not found");
  }
  consultant.status = "suspended";
  consultant.suspendedReason = String(req.body?.reason || "").slice(0, 1000);
  await consultant.save();
  res.json({ success: true, consultant });
});

// @GET /api/admin/commissions?consultantId=&status=&period=&kind= -> ledger
const listCommissions = asyncHandler(async (req, res) => {
  const { consultantId, status, period, kind } = req.query;
  const filter = {};
  if (consultantId) filter.consultantId = consultantId;
  if (status) filter.status = status;
  if (period) filter.period = period;
  if (kind) filter.kind = kind;

  const entries = await CommissionEntry.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .populate("workspaceId", "name")
    .populate("consultantId", "fullName code")
    .lean();

  res.json({ entries, total: entries.length });
});

// @POST /api/admin/commissions/:id/verify  (accrued → verified)
const verifyCommission = asyncHandler(async (req, res) => {
  const entry = await CommissionEntry.findById(req.params.id);
  if (!entry) {
    res.status(404);
    throw new Error("Ledger entry not found");
  }
  if (entry.status !== "accrued") {
    res.status(400);
    throw new Error(`Only accrued entries can be verified (is: ${entry.status})`);
  }
  entry.status = "verified";
  entry.verifiedAt = new Date();
  entry.verifiedBy = req.admin?.email || "";
  await entry.save();
  res.json({ success: true, entry });
});

/** Shared: flip one entry to paid + sync the consultant's USD paid total. */
async function markEntryPaid(entry, adminEmail, payoutReference) {
  entry.status = "paid";
  entry.paidAt = new Date();
  entry.paidBy = adminEmail || "";
  entry.payoutReference = String(payoutReference || "").slice(0, 200);
  await entry.save();
  if (
    entry.kind === "consultant_share" &&
    entry.currency === "USD" &&
    entry.consultantId
  ) {
    await Consultant.updateOne(
      { _id: entry.consultantId },
      { $inc: { "totals.paid": entry.amount } },
    );
  }
}

// @POST /api/admin/commissions/:id/mark-paid  { payoutReference }
const markCommissionPaid = asyncHandler(async (req, res) => {
  const entry = await CommissionEntry.findById(req.params.id);
  if (!entry) {
    res.status(404);
    throw new Error("Ledger entry not found");
  }
  if (!["verified", "accrued"].includes(entry.status)) {
    res.status(400);
    throw new Error(
      `Only verified/accrued entries can be marked paid (is: ${entry.status})`,
    );
  }
  await markEntryPaid(entry, req.admin?.email, req.body?.payoutReference);
  res.json({ success: true, entry });
});

// @POST /api/admin/commissions/mark-paid-bulk
//   { consultantId, period, payoutReference } -> pay out a consultant's month
const markCommissionsPaidBulk = asyncHandler(async (req, res) => {
  const { consultantId, period, payoutReference } = req.body || {};
  if (!consultantId || !period) {
    res.status(400);
    throw new Error("consultantId and period (YYYY-MM) are required");
  }

  const entries = await CommissionEntry.find({
    consultantId,
    period,
    kind: "consultant_share",
    status: "verified",
  });

  const totals = {};
  for (const entry of entries) {
    await markEntryPaid(entry, req.admin?.email, payoutReference);
    const cur = entry.currency || "USD";
    totals[cur] = round2((totals[cur] || 0) + entry.amount);
  }

  res.json({
    success: true,
    count: entries.length,
    totals: Object.entries(totals).map(([currency, amount]) => ({
      currency,
      amount,
    })),
  });
});

module.exports = {
  login,
  overview,
  listUsers,
  listSubscriptions,
  listActivity,
  timeline,
  listConsultants,
  approveConsultant,
  suspendConsultant,
  listCommissions,
  verifyCommission,
  markCommissionPaid,
  markCommissionsPaidBulk,
};
