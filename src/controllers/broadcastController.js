const asyncHandler = require("express-async-handler");
const BroadcastCampaign = require("../models/BroadcastCampaign");
const Contact = require("../models/Contact");
const { sendMessage } = require("../services/whatsapp/dispatcher");
const { getBroadcastQueue } = require("../jobs");

// @GET /api/broadcasts — List campaigns
const getCampaigns = asyncHandler(async (req, res) => {
  const campaigns = await BroadcastCampaign.find({
    workspaceId: req.workspace._id,
  })
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

  const { name, message, mediaUrl, mediaType, targetSegment, scheduledAt } =
    req.body;
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

  campaign.status = "sending";
  campaign.sentAt = new Date();
  await campaign.save();

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
