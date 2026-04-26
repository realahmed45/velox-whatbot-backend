const { Worker } = require("bullmq");
const BroadcastCampaign = require("../models/BroadcastCampaign");
const Contact = require("../models/Contact");
const Workspace = require("../models/Workspace");
const ig = require("../services/instagram/metaService");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const DELAY_MS = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = (connection) => {
  const worker = new Worker(
    "broadcasts",
    async (job) => {
      const { campaignId, workspaceId } = job.data;
      logger.info(`[BroadcastJob] Starting campaign ${campaignId}`);

      const campaign = await BroadcastCampaign.findById(campaignId);
      if (!campaign || campaign.status === "cancelled") return;

      const workspace = await Workspace.findById(workspaceId).select(
        "+instagram.accessToken +instagram.igUserId",
      );
      if (!workspace || workspace.instagram?.status !== "connected") {
        campaign.status = "failed";
        campaign.stats = campaign.stats || {};
        campaign.stats.error = "Instagram not connected";
        await campaign.save();
        return;
      }

      let token;
      try {
        token = decrypt(workspace.instagram.accessToken);
      } catch {
        campaign.status = "failed";
        campaign.stats = campaign.stats || {};
        campaign.stats.error = "Token unreadable. Reconnect Instagram.";
        await campaign.save();
        return;
      }

      const filter = {
        workspaceId,
        isDeleted: { $ne: true },
        optedIn: { $ne: false },
        igUserId: { $exists: true, $ne: null },
      };
      const seg = campaign.targetSegment;
      if (seg?.type === "tag" && seg.tags?.length)
        filter.tags = { $in: seg.tags };

      const contacts = await Contact.find(filter)
        .select("igUserId name igUsername")
        .lean();

      let sent = 0;
      let failed = 0;

      for (const contact of contacts) {
        if (!contact.igUserId) {
          failed++;
          continue;
        }
        try {
          const text = String(campaign.message || "").replace(
            /{{name}}/gi,
            contact.name || contact.igUsername || "there",
          );
          const result = await ig.sendDM(token, contact.igUserId, text);
          if (result?.success) sent++;
          else {
            failed++;
            logger.warn(
              `[BroadcastJob] send failed ${contact.igUserId}: ${result?.error}`,
            );
            // If we got rate-limited, back off significantly to avoid escalating.
            if (result?.rateLimited) {
              logger.warn(
                `[BroadcastJob] rate-limited; sleeping 60s before next send`,
              );
              await sleep(60_000);
            }
          }
        } catch (err) {
          logger.error(
            `[BroadcastJob] Failed to send to ${contact.igUserId}: ${err.message}`,
          );
          failed++;
        }
        await sleep(DELAY_MS);
      }

      campaign.status = "sent";
      campaign.stats = campaign.stats || {};
      campaign.stats.sent = sent;
      campaign.stats.failed = failed;
      campaign.stats.totalTargeted = contacts.length;
      await campaign.save();

      logger.info(
        `[BroadcastJob] Campaign ${campaignId} done. sent:${sent} failed:${failed}`,
      );
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, err) => {
    logger.error(`[BroadcastJob] Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
};
