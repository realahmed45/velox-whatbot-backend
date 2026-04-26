/**
 * ROI / Conversion Reports (D4).
 * Aggregates automation-driven outcomes: DMs sent by automation, comment-to-DM
 * captures, giveaway entries, link-in-bio clicks.
 * Estimated revenue = conversions × average order value (workspace setting, default $25).
 */
const asyncHandler = require("express-async-handler");
const Message = require("../models/Message");
const Contact = require("../models/Contact");
const Workspace = require("../models/Workspace");

let LinkInBio;
try {
  LinkInBio = require("../models/LinkInBio");
} catch {
  LinkInBio = null;
}

let Giveaway;
try {
  Giveaway = require("../models/Giveaway");
} catch {
  Giveaway = null;
}

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

  // Link-in-bio clicks in window
  let linkClicks = 0;
  let linkViews = 0;
  if (LinkInBio) {
    const bio = await LinkInBio.findOne({ workspaceId: wsId });
    if (bio) {
      linkViews = bio.totalViews || 0;
      linkClicks = (bio.links || []).reduce(
        (sum, l) => sum + (l.clicks || 0),
        0,
      );
    }
  }

  // Giveaway entries
  let giveawayEntries = 0;
  if (Giveaway) {
    const giveaways = await Giveaway.find({
      workspaceId: wsId,
      createdAt: { $gte: since },
    });
    giveawayEntries = giveaways.reduce(
      (sum, g) => sum + (g.entries?.length || 0),
      0,
    );
  }

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
      linkInBioViews: linkViews,
      linkInBioClicks: linkClicks,
      giveawayEntries,
      estimatedSales,
      estimatedRevenue,
      averageOrderValue: aov,
    },
  });
});
