const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");

// GET /api/referral — get this workspace's referral code + stats
exports.getReferral = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id);
  const ref = ws?.referral || {};
  const baseUrl = process.env.CLIENT_URL || "https://botlify.site";
  res.json({
    success: true,
    referral: {
      code: ref.code || null,
      link: ref.code ? `${baseUrl}/register?ref=${ref.code}` : null,
      signups: ref.signups || 0,
      paidConversions: ref.paidConversions || 0,
      creditsEarned: ref.creditsEarned || 0,
      creditsAvailable: ref.creditsAvailable || 0,
    },
  });
});

// POST /api/referral/track  { code, newWorkspaceId }  — called by auth on signup
exports.trackReferral = asyncHandler(async (req, res) => {
  const { code, newWorkspaceId } = req.body;
  if (!code || !newWorkspaceId) {
    res.status(400);
    throw new Error("code and newWorkspaceId required");
  }
  const referrer = await Workspace.findOne({ "referral.code": code });
  if (!referrer) {
    return res.json({ success: true, matched: false });
  }
  await Workspace.findByIdAndUpdate(newWorkspaceId, {
    "referral.referredBy": referrer._id,
  });
  referrer.referral.signups = (referrer.referral.signups || 0) + 1;
  await referrer.save();
  res.json({ success: true, matched: true });
});

// POST /api/referral/convert  (internal, called when referred workspace upgrades)
// Awards $5 credit per paid conversion.
exports.convertReferral = asyncHandler(async (req, res) => {
  const { workspaceId } = req.body;
  const ws = await Workspace.findById(workspaceId);
  if (!ws?.referral?.referredBy) {
    return res.json({ success: true, awarded: false });
  }
  const referrer = await Workspace.findById(ws.referral.referredBy);
  if (!referrer) return res.json({ success: true, awarded: false });

  const CREDIT = 5; // $5 per paid conversion
  referrer.referral.paidConversions =
    (referrer.referral.paidConversions || 0) + 1;
  referrer.referral.creditsEarned =
    (referrer.referral.creditsEarned || 0) + CREDIT;
  referrer.referral.creditsAvailable =
    (referrer.referral.creditsAvailable || 0) + CREDIT;
  await referrer.save();
  res.json({ success: true, awarded: true, credit: CREDIT });
});
