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
    },
    subscriptions: {
      active: activeSubs,
      trialing: trialingSubs,
      estimatedMrr: Math.round(mrr),
    },
    generatedAt: now,
  });
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

module.exports = { login, overview, listUsers, listSubscriptions };
