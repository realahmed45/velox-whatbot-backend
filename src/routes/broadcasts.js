const express = require("express");
const router = express.Router();
const asyncHandler = require("express-async-handler");
const { protect, requireWorkspace } = require("../middleware/auth");
const BroadcastCampaign = require("../models/BroadcastCampaign");
const Contact = require("../models/Contact");
const ig = require("../services/instagram");
const { decrypt } = require("../utils/encryption");
const Workspace = require("../models/Workspace");

router.use(protect);
router.use(requireWorkspace);

// @GET /api/broadcasts
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const campaigns = await BroadcastCampaign.find({
      workspaceId: req.workspace._id,
    }).sort({ createdAt: -1 });
    res.json({ success: true, campaigns });
  }),
);

// @POST /api/broadcasts — Create broadcast
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, message, targetSegment, scheduledAt, mediaUrl } = req.body;
    if (!name || !message) {
      res.status(400);
      throw new Error("Name and message required");
    }

    const plan = req.workspace.subscription.plan;
    if (["starter"].includes(plan)) {
      res.status(403);
      throw new Error("Broadcasts require a Growth plan or higher");
    }

    const campaign = await BroadcastCampaign.create({
      workspaceId: req.workspace._id,
      name,
      message,
      targetSegment: targetSegment || { type: "all" },
      scheduledAt,
      isScheduled: !!scheduledAt,
      mediaUrl,
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, campaign });
  }),
);

// @POST /api/broadcasts/:id/send — Send broadcast immediately
router.post(
  "/:id/send",
  asyncHandler(async (req, res) => {
    const campaign = await BroadcastCampaign.findOne({
      _id: req.params.id,
      workspaceId: req.workspace._id,
    });
    if (!campaign) {
      res.status(404);
      throw new Error("Campaign not found");
    }
    if (campaign.status === "sent") {
      res.status(400);
      throw new Error("Campaign already sent");
    }

    // Build contact filter
    const filter = {
      workspaceId: req.workspace._id,
      isDeleted: false,
      optedIn: true,
    };
    const seg = campaign.targetSegment;
    if (seg.type === "tag" && seg.tags?.length) filter.tags = { $in: seg.tags };
    if (seg.type === "date_range")
      filter[seg.dateField] = { $gte: seg.dateFrom, $lte: seg.dateTo };

    const contacts = await Contact.find(filter).select("phone igUserId");
    campaign.stats.totalTargeted = contacts.length;
    campaign.status = "sending";
    campaign.sentAt = new Date();
    await campaign.save();

    res.json({
      success: true,
      message: `Sending broadcast to ${contacts.length} contacts...`,
      campaign,
    });

    // Send via Instagram DM in background
    setImmediate(async () => {
      let sentCount = 0;
      try {
        const wsWithToken = await Workspace.findById(req.workspace._id).select(
          "+instagram.accessToken",
        );
        const token = wsWithToken?.instagram?.accessToken
          ? decrypt(wsWithToken.instagram.accessToken)
          : null;
        if (token) {
          for (const contact of contacts) {
            if (!contact.igUserId) continue;
            try {
              const result = await ig.sendDM(
                token,
                contact.igUserId,
                campaign.message,
              );
              if (result.success) sentCount++;
              await new Promise((r) => setTimeout(r, 300)); // rate limiting
            } catch {}
          }
        }
      } catch {}
      campaign.status = "sent";
      campaign.stats.sent = sentCount;
      await campaign.save();
    });
  }),
);

// @GET /api/broadcasts/:id — Get broadcast details
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const campaign = await BroadcastCampaign.findOne({
      _id: req.params.id,
      workspaceId: req.workspace._id,
    });
    if (!campaign) {
      res.status(404);
      throw new Error("Campaign not found");
    }
    res.json({ success: true, campaign });
  }),
);

// @POST /api/broadcasts/:id/preview — Preview broadcast
router.post(
  "/:id/preview",
  asyncHandler(async (req, res) => {
    const campaign = await BroadcastCampaign.findOne({
      _id: req.params.id,
      workspaceId: req.workspace._id,
    });

    if (!campaign) {
      res.status(404);
      throw new Error("Campaign not found");
    }

    // Count total recipients
    const filter = {
      workspaceId: req.workspace._id,
      isDeleted: false,
      optedIn: true,
    };
    const seg = campaign.targetSegment;
    if (seg?.type === "tag" && seg.tags?.length)
      filter.tags = { $in: seg.tags };

    const totalRecipients = await Contact.countDocuments(filter);
    const sampleContacts = await Contact.find(filter)
      .select("name username phone")
      .limit(5)
      .lean();

    res.json({
      success: true,
      preview: {
        campaignName: campaign.name,
        message: campaign.message,
        mediaUrl: campaign.mediaUrl,
        mediaType: campaign.mediaType,
        estimatedReach: totalRecipients,
        sampleRecipients: sampleContacts,
        scheduledAt: campaign.scheduledAt,
        status: campaign.status,
      },
    });
  }),
);

// @DELETE /api/broadcasts/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
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
      throw new Error("Cannot delete a campaign that is currently sending");
    }
    await campaign.deleteOne();
    res.json({ success: true, message: "Campaign deleted" });
  }),
);

module.exports = router;
