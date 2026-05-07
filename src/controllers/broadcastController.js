const asyncHandler = require("express-async-handler");
const BroadcastCampaign = require("../models/BroadcastCampaign");
const Contact = require("../models/Contact");
const Workspace = require("../models/Workspace");
const { sendMessage } = require("../services/whatsapp/dispatcher");
const { getBroadcastQueue } = require("../jobs");
const { getPlan } = require("../config/plans");

// @GET /api/broadcasts — List campaigns
const getCampaigns = asyncHandler(async (req, res) => {
  const filter = { workspaceId: req.workspace._id };
  const { channel } = req.query;
  if (channel && ["whatsapp", "instagram"].includes(channel)) {
    filter.channel = channel;
  }
  const campaigns = await BroadcastCampaign.find(filter)
    .populate("createdBy", "name")
    .sort({ createdAt: -1 });
  res.json({ success: true, campaigns });
});

// @POST /api/broadcasts — Create broadcast
const createCampaign = asyncHandler(async (req, res) => {
  const plan = req.workspace.subscription.plan;
  if (!["business", "agency"].includes(plan)) {
    // Growth can use add-on credits
    if (plan === "growth") {
      // Check if they have broadcast credits — for MVP we allow it
    } else {
      res.status(403);
      throw new Error("Broadcast campaigns require Growth plan or higher");
    }
  }

  const {
    name,
    message,
    mediaUrl,
    mediaType,
    targetSegment,
    scheduledAt,
    channel,
  } = req.body;
  if (!name || !message) {
    res.status(400);
    throw new Error("Name and message required");
  }

  // Count targets for preview
  const contactCount = await countTargetContacts(
    req.workspace._id,
    targetSegment,
  );

  const campaign = await BroadcastCampaign.create({
    workspaceId: req.workspace._id,
    channel: channel === "instagram" ? "instagram" : "whatsapp",
    name,
    message,
    mediaUrl,
    mediaType,
    targetSegment: targetSegment || { type: "all" },
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    isScheduled: !!scheduledAt,
    status: scheduledAt ? "scheduled" : "draft",
    stats: { totalTargeted: contactCount },
    createdBy: req.user._id,
  });

  res
    .status(201)
    .json({ success: true, campaign, estimatedReach: contactCount });
});

// @POST /api/broadcasts/:id/send — Send/queue broadcast
const sendCampaign = asyncHandler(async (req, res) => {
  const campaign = await BroadcastCampaign.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!campaign) {
    res.status(404);
    throw new Error("Campaign not found");
  }
  if (["sent", "sending"].includes(campaign.status)) {
    res.status(400);
    throw new Error("Campaign already sent or in progress");
  }

  // ─── WhatsApp marketing quota guard ───────────────────────
  // Protects margin: a customer cannot trigger more paid Meta marketing
  // conversations than their plan allows. The check runs only when the
  // workspace will actually use WhatsApp for the broadcast.
  const usesWhatsApp =
    req.workspace?.whatsapp?.status === "connected" &&
    req.workspace?.whatsapp?.type &&
    req.workspace.whatsapp.type !== "none";

  if (usesWhatsApp) {
    const plan = getPlan(req.workspace.subscription?.plan);
    const limit = plan?.limits?.waMarketingLimit ?? 0;
    const used = req.workspace.usage?.waMarketingThisMonth || 0;
    const reach =
      campaign.stats?.totalTargeted ||
      (await countTargetContacts(req.workspace._id, campaign.targetSegment));
    if (limit !== -1 && used + reach > limit) {
      const remaining = Math.max(0, limit - used);
      res.status(402);
      throw new Error(
        `Marketing limit reached. Your plan allows ${limit} marketing messages per month — ${remaining} remaining, but this broadcast targets ${reach} contacts. Upgrade your plan or reduce the audience.`,
      );
    }
  }

  campaign.status = "sending";
  campaign.sentAt = new Date();
  await campaign.save();

  // Optimistically increment the marketing counter so concurrent broadcasts
  // can't both squeeze through the limit. The job decrements on failure.
  if (usesWhatsApp) {
    const reach = campaign.stats?.totalTargeted || 0;
    if (reach > 0) {
      await Workspace.updateOne(
        { _id: req.workspace._id },
        { $inc: { "usage.waMarketingThisMonth": reach } },
      );
    }
  }

  // Queue the broadcast job
  const queue = getBroadcastQueue();
  if (queue) {
    await queue.add(
      "send-broadcast",
      {
        campaignId: campaign._id.toString(),
        workspaceId: req.workspace._id.toString(),
      },
      { attempts: 2, backoff: { type: "exponential", delay: 5000 } },
    );
  }

  res.json({
    success: true,
    message: "Broadcast queued for sending",
    campaign,
  });
});

// @GET /api/broadcasts/:id — Get campaign stats
const getCampaign = asyncHandler(async (req, res) => {
  const campaign = await BroadcastCampaign.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!campaign) {
    res.status(404);
    throw new Error("Campaign not found");
  }
  res.json({ success: true, campaign });
});

// @DELETE /api/broadcasts/:id — Cancel/delete campaign
const deleteCampaign = asyncHandler(async (req, res) => {
  const campaign = await BroadcastCampaign.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!campaign) {
    res.status(404);
    throw new Error("Campaign not found");
  }
  if (campaign.status === "sending") {
    res.status(400);
    throw new Error("Cannot delete a campaign that is sending");
  }
  if (campaign.status === "scheduled") campaign.status = "cancelled";
  else await campaign.deleteOne();
  res.json({ success: true, message: "Campaign cancelled" });
});

// @GET /api/broadcasts/preview — Count targets before creating
const previewTargets = asyncHandler(async (req, res) => {
  const { targetSegment } = req.query;
  const segment = targetSegment ? JSON.parse(targetSegment) : { type: "all" };
  const count = await countTargetContacts(req.workspace._id, segment);
  res.json({ success: true, estimatedReach: count });
});

const countTargetContacts = async (workspaceId, segment) => {
  const filter = { workspaceId, isDeleted: false, optedIn: true };
  if (segment?.type === "tag" && segment.tags?.length) {
    filter.tags = { $in: segment.tags };
  } else if (segment?.type === "date_range" && segment.dateField) {
    filter[segment.dateField] = {};
    if (segment.dateFrom)
      filter[segment.dateField].$gte = new Date(segment.dateFrom);
    if (segment.dateTo)
      filter[segment.dateField].$lte = new Date(segment.dateTo);
  }
  return Contact.countDocuments(filter);
};

module.exports = {
  getCampaigns,
  createCampaign,
  sendCampaign,
  getCampaign,
  deleteCampaign,
  previewTargets,
};
