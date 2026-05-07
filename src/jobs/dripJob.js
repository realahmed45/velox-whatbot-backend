/**
 * Botlify — Drip Campaign Runner
 * Cron-processed every 1 minute. Advances enrollments whose nextRunAt has passed.
 */
const { DripCampaign, DripEnrollment } = require("../models/DripCampaign");
const Workspace = require("../models/Workspace");
const Contact = require("../models/Contact");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const { sendDM } = require("../services/instagram");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const personalize = (tpl, contact) => {
  const firstName = (contact?.name || contact?.igUsername || "there")
    .toString()
    .split(" ")[0];
  return (tpl || "")
    .replace(/\{name\}/gi, firstName)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{username\}/gi, contact?.igUsername || "");
};

const processDripEnrollments = async () => {
  const now = new Date();
  const due = await DripEnrollment.find({
    status: "active",
    nextRunAt: { $lte: now },
  })
    .limit(50)
    .populate("contactId");

  for (const enrollment of due) {
    try {
      const campaign = await DripCampaign.findById(enrollment.campaignId);
      if (!campaign || !campaign.enabled) {
        enrollment.status = "cancelled";
        await enrollment.save();
        continue;
      }

      const step = campaign.steps[enrollment.currentStep];
      if (!step) {
        enrollment.status = "completed";
        await enrollment.save();
        campaign.stats.completed = (campaign.stats.completed || 0) + 1;
        await campaign.save();
        continue;
      }

      const ws = await Workspace.findById(enrollment.workspaceId).select(
        "+instagram.accessToken +instagram.igUserId",
      );
      if (!ws?.instagram?.accessToken) {
        enrollment.lastError = "Instagram not connected";
        enrollment.nextRunAt = new Date(Date.now() + 60 * 60 * 1000); // retry in 1h
        await enrollment.save();
        continue;
      }

      const token = decrypt(ws.instagram.accessToken);
      const contact = enrollment.contactId;
      if (!contact?.igUserId) {
        enrollment.status = "failed";
        enrollment.lastError = "Contact has no IG user id";
        await enrollment.save();
        continue;
      }

      const text = personalize(step.message, contact);
      await sendDM(token, contact.igUserId, text);

      // Log the outbound message
      const conv = await Conversation.findOneAndUpdate(
        {
          workspaceId: enrollment.workspaceId,
          contactId: contact._id,
          channelType: "instagram",
        },
        {
          $setOnInsert: {
            workspaceId: enrollment.workspaceId,
            contactId: contact._id,
            channelType: "instagram",
          },
          $set: { lastMessageAt: new Date() },
        },
        { upsert: true, new: true },
      );
      await Message.create({
        workspaceId: enrollment.workspaceId,
        conversationId: conv._id,
        contactId: contact._id,
        direction: "outbound",
        sender: "bot",
        text,
        channelType: "instagram",
        status: "sent",
        metadata: {
          trigger: "drip",
          campaignId: campaign._id,
          step: enrollment.currentStep,
        },
      });

      // Advance
      enrollment.currentStep += 1;
      const nextStep = campaign.steps[enrollment.currentStep];
      if (!nextStep) {
        enrollment.status = "completed";
        enrollment.nextRunAt = null;
        campaign.stats.completed = (campaign.stats.completed || 0) + 1;
        await campaign.save();
      } else {
        enrollment.nextRunAt = new Date(
          Date.now() + (nextStep.delayMinutes || 0) * 60 * 1000,
        );
      }
      enrollment.lastError = null;
      await enrollment.save();
    } catch (err) {
      enrollment.lastError = err.message;
      // retry in 30 min
      enrollment.nextRunAt = new Date(Date.now() + 30 * 60 * 1000);
      await enrollment.save();
      logger.warn(`[drip] enrollment ${enrollment._id} failed: ${err.message}`);
    }
  }

  return { processed: due.length };
};

module.exports = { processDripEnrollments };
