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
      const sendResult = await sendDM(token, contact.igUserId, text);

      // If the send failed, DO NOT advance the step — otherwise the message is
      // silently skipped (this is what dropped "middle" drip messages). Retry:
      //  - rate limit → back off 30 min
      //  - 24h window / other → back off 1 hour, up to a few attempts
      if (!sendResult || sendResult.success === false) {
        enrollment.attempts = (enrollment.attempts || 0) + 1;
        enrollment.lastError = sendResult?.error || "send failed";
        if (enrollment.attempts >= 5) {
          // Give up on this step after repeated failures; move on so the
          // sequence isn't stuck forever (e.g. contact permanently unreachable).
          logger.warn(
            `[drip] enrollment ${enrollment._id} step ${enrollment.currentStep} giving up after ${enrollment.attempts} attempts: ${enrollment.lastError}`,
          );
          enrollment.currentStep += 1;
          const skipNext = campaign.steps[enrollment.currentStep];
          if (!skipNext) {
            enrollment.status = "completed";
            enrollment.nextRunAt = null;
          } else {
            enrollment.attempts = 0;
            enrollment.nextRunAt = new Date(
              Date.now() + (skipNext.delayMinutes || 0) * 60 * 1000,
            );
          }
          await enrollment.save();
          continue;
        }
        enrollment.nextRunAt = new Date(
          Date.now() + (sendResult?.rateLimited ? 30 : 60) * 60 * 1000,
        );
        await enrollment.save();
        logger.warn(
          `[drip] enrollment ${enrollment._id} step ${enrollment.currentStep} send failed (attempt ${enrollment.attempts}), retrying: ${enrollment.lastError}`,
        );
        continue;
      }

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

      // Advance (send succeeded).
      enrollment.currentStep += 1;
      enrollment.attempts = 0;
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
