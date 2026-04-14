const { Worker } = require("bullmq");
const BroadcastCampaign = require("../models/BroadcastCampaign");
const Contact = require("../models/Contact");
const Workspace = require("../models/Workspace");
const { sendMessage } = require("../services/whatsapp/dispatcher");
const logger = require("../utils/logger");

const DELAY_MS = 1200; // ~50 msgs/min to avoid rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = (connection) => {
  const worker = new Worker(
    "broadcasts",
    async (job) => {
      const { campaignId, workspaceId } = job.data;
      logger.info(`[BroadcastJob] Starting campaign ${campaignId}`);

      const campaign = await BroadcastCampaign.findById(campaignId);
      if (!campaign || campaign.status === "cancelled") return;

      const workspace = await Workspace.findById(workspaceId);
      if (!workspace) {
        campaign.status = "failed";
        await campaign.save();
        return;
      }

      // Build contact query
      const filter = { workspaceId, isDeleted: false, optedIn: true };
      const seg = campaign.targetSegment;
      if (seg?.type === "tag" && seg.tags?.length)
        filter.tags = { $in: seg.tags };

      const contacts = await Contact.find(filter).select("phone name").lean();
      let sent = 0,
        failed = 0;

      for (const contact of contacts) {
        try {
          let text = campaign.message.replace(
            /{{name}}/gi,
            contact.name || "Customer",
          );
          const msg = campaign.mediaUrl
            ? { type: "image", url: campaign.mediaUrl, caption: text }
            : { type: "text", text };

          await sendMessage(workspace, contact.phone, msg);
          sent++;
        } catch (err) {
          logger.error(
            `[BroadcastJob] Failed to send to ${contact.phone}: ${err.message}`,
          );
          failed++;
        }
        await sleep(DELAY_MS);
      }

      campaign.status = "sent";
      campaign.stats.sent = sent;
      campaign.stats.failed = failed;
      campaign.stats.totalTargeted = contacts.length;
      await campaign.save();

      logger.info(
        `[BroadcastJob] Campaign ${campaignId} done — sent:${sent} failed:${failed}`,
      );
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error(`[BroadcastJob] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
};
