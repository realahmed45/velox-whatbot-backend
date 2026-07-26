/**
 * ROI / Conversion Reports (D4).
 * Aggregates automation-driven outcomes: DMs sent by automation and new contacts.
 * Estimated revenue = conversions × average order value (workspace setting, default $25).
 */
const asyncHandler = require("express-async-handler");
const Message = require("../models/Message");
const Contact = require("../models/Contact");
const Workspace = require("../models/Workspace");

// GET /api/analytics/roi?days=30
exports.getRoiReport = asyncHandler(async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const wsId = req.workspace._id;

  const [automatedMsgs, newContacts] = await Promise.all([
    Message.countDocuments({
      workspaceId: wsId,
      direction: "outbound",
      "metadata.triggerType": { $exists: true, $ne: null },
      createdAt: { $gte: since },
    }),
    Contact.countDocuments({ workspaceId: wsId, createdAt: { $gte: since } }),
  ]);

  // Rough conversion estimate: 3% of automated DMs → sale
  const ws = await Workspace.findById(wsId);
  const aov = ws?.settings?.averageOrderValue || 25;
  const estimatedSales = Math.round(automatedMsgs * 0.03);
  const estimatedRevenue = estimatedSales * aov;

  res.json({
    success: true,
    period: { days, since },
    metrics: {
      automatedMessages: automatedMsgs,
      newContacts,
      estimatedSales,
      estimatedRevenue,
      averageOrderValue: aov,
    },
  });
});
