/**
 * consultantController — the door-to-door marketer program.
 *
 *   GET  /api/consultants/validate/:code → PUBLIC referral-code check
 *   POST /api/consultants/apply          → apply to become a consultant
 *   GET  /api/consultants/me             → profile + earnings stats + ledger
 *   PUT  /api/consultants/me             → update profile / payout details
 *   GET  /api/consultants/me/hotels      → hotels this consultant signed
 *   POST /api/consultants/attribute      → hotel owner enters a consultant code
 *
 * Money math lives in commissionService; this file only reads the ledger.
 */
const asyncHandler = require("express-async-handler");
const Consultant = require("../models/Consultant");
const CommissionEntry = require("../models/CommissionEntry");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");

const normalizeCode = (code) => String(code || "").trim().toUpperCase();

// @GET /validate/:code — PUBLIC. Only approved consultants validate.
const validateCode = asyncHandler(async (req, res) => {
  const code = normalizeCode(req.params.code);
  const consultant = code
    ? await Consultant.findOne({ code, status: "approved" })
        .select("fullName")
        .lean()
    : null;
  res.json({
    valid: !!consultant,
    consultantName: consultant?.fullName || null,
  });
});

// @POST /apply — create a pending consultant profile for the logged-in user.
const apply = asyncHandler(async (req, res) => {
  const existing = await Consultant.findOne({ userId: req.user._id });
  if (existing) {
    return res.json({
      success: true,
      consultant: existing,
      message: "You have already applied",
    });
  }

  const b = req.body || {};
  const consultant = await Consultant.create({
    userId: req.user._id,
    status: "pending",
    fullName: String(b.fullName || req.user.name || "").slice(0, 200),
    phone: String(b.phone || "").slice(0, 50),
    country: String(b.country || "ID").slice(0, 10),
    city: String(b.city || "").slice(0, 100),
    payout: {
      bankName: String(b.payout?.bankName || "").slice(0, 200),
      accountName: String(b.payout?.accountName || "").slice(0, 200),
      accountNumber: String(b.payout?.accountNumber || "").slice(0, 100),
      notes: String(b.payout?.notes || "").slice(0, 1000),
    },
  });

  // Flag the account as a consultant — but never demote a user who actually
  // owns a workspace ("owner" is also the signup default, so only flip it for
  // users with no owned workspace).
  try {
    if (req.user.role === "owner") {
      const ownsWorkspace = await Workspace.exists({ owner: req.user._id });
      if (!ownsWorkspace) {
        req.user.role = "consultant";
        await req.user.save();
      }
    }
  } catch (e) {
    logger.warn("[consultant] role update failed", { err: e.message });
  }

  logger.info(
    `[consultant] application user=${req.user._id} code=${consultant.code}`,
  );
  res.status(201).json({ success: true, consultant });
});

/** Aggregate a consultant's share ledger into per-currency status sums. */
async function earningsByCurrency(consultantId) {
  const sums = await CommissionEntry.aggregate([
    { $match: { kind: "consultant_share", consultantId } },
    {
      $group: {
        _id: { currency: "$currency", status: "$status" },
        total: { $sum: "$amount" },
      },
    },
  ]);
  const byCurrency = {};
  for (const row of sums) {
    const cur = row._id.currency || "USD";
    byCurrency[cur] = byCurrency[cur] || {
      currency: cur,
      accrued: 0,
      verified: 0,
      paid: 0,
    };
    const status = row._id.status;
    if (status === "accrued") byCurrency[cur].accrued += row.total;
    else if (status === "verified" || status === "invoiced")
      byCurrency[cur].verified += row.total;
    else if (status === "paid") byCurrency[cur].paid += row.total;
    // void entries are excluded from all buckets
  }
  const round = (n) => Math.round(n * 100) / 100;
  return Object.values(byCurrency).map((c) => ({
    currency: c.currency,
    accrued: round(c.accrued),
    verified: round(c.verified),
    paid: round(c.paid),
  }));
}

// @GET /me — consultant profile + stats + latest ledger entries.
const getMe = asyncHandler(async (req, res) => {
  const consultant = await Consultant.findOne({ userId: req.user._id });
  if (!consultant) {
    res.status(404);
    throw new Error("You are not registered as a consultant");
  }

  const [byCurrency, entries] = await Promise.all([
    earningsByCurrency(consultant._id),
    CommissionEntry.find({
      kind: "consultant_share",
      consultantId: consultant._id,
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("workspaceId", "name")
      .lean(),
  ]);

  res.json({
    success: true,
    consultant,
    stats: {
      hotelsSigned: consultant.totals?.hotelsSigned || 0,
      byCurrency,
    },
    entries,
  });
});

// @PUT /me — update profile / payout details.
const updateMe = asyncHandler(async (req, res) => {
  const consultant = await Consultant.findOne({ userId: req.user._id });
  if (!consultant) {
    res.status(404);
    throw new Error("You are not registered as a consultant");
  }

  const b = req.body || {};
  if (b.fullName != null) consultant.fullName = String(b.fullName).slice(0, 200);
  if (b.phone != null) consultant.phone = String(b.phone).slice(0, 50);
  if (b.country != null) consultant.country = String(b.country).slice(0, 10);
  if (b.city != null) consultant.city = String(b.city).slice(0, 100);
  if (b.payout && typeof b.payout === "object") {
    const p = b.payout;
    if (p.bankName != null)
      consultant.payout.bankName = String(p.bankName).slice(0, 200);
    if (p.accountName != null)
      consultant.payout.accountName = String(p.accountName).slice(0, 200);
    if (p.accountNumber != null)
      consultant.payout.accountNumber = String(p.accountNumber).slice(0, 100);
    if (p.notes != null)
      consultant.payout.notes = String(p.notes).slice(0, 1000);
  }
  await consultant.save();

  res.json({ success: true, consultant });
});

// @GET /me/hotels — the hotels attributed to this consultant.
const myHotels = asyncHandler(async (req, res) => {
  const consultant = await Consultant.findOne({ userId: req.user._id });
  if (!consultant) {
    res.status(404);
    throw new Error("You are not registered as a consultant");
  }

  const workspaces = await Workspace.find({
    "acquisition.consultantId": consultant._id,
  })
    .select("name acquisition.attributedAt subscription.plan subscription.status")
    .sort({ "acquisition.attributedAt": -1 })
    .lean();

  const hotels = workspaces.map((w) => ({
    id: w._id,
    name: w.name,
    attributedAt: w.acquisition?.attributedAt || null,
    plan: w.subscription?.plan || "free",
    status: w.subscription?.status || null,
  }));

  res.json({ success: true, hotels, total: hotels.length });
});

// @POST /attribute — hotel owner enters a consultant's referral code.
const attribute = asyncHandler(async (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) {
    res.status(400);
    throw new Error("Consultant code is required");
  }

  const consultant = await Consultant.findOne({ code, status: "approved" });
  if (!consultant) {
    res.status(404);
    throw new Error("Invalid consultant code");
  }

  const workspace = req.workspace;
  if (workspace.acquisition?.consultantId) {
    res.status(400);
    throw new Error("This workspace is already attributed to a consultant");
  }

  workspace.acquisition = {
    consultantId: consultant._id,
    consultantCode: consultant.code,
    attributedAt: new Date(),
  };
  await workspace.save();

  await Consultant.updateOne(
    { _id: consultant._id },
    { $inc: { "totals.hotelsSigned": 1 } },
  );

  logger.info(
    `[consultant] attributed ws=${workspace._id} code=${consultant.code}`,
  );
  res.json({ success: true, acquisition: workspace.acquisition });
});

module.exports = {
  validateCode,
  apply,
  getMe,
  updateMe,
  myHotels,
  attribute,
};
