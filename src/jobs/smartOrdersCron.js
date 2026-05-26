/**
 * Smart Orders cron jobs — Instagram-only build.
 *
 * Daily digest is now email-only (WA dispatcher removed).
 * Ghost follow-up scan is disabled since we cannot initiate
 * outbound Instagram DMs to customers outside an active conversation window.
 */
const cron = require("node-cron");
const Workspace = require("../models/Workspace");
const Order = require("../models/Order");
const logger = require("../utils/logger");

const startCrons = () => {
  // Daily digest — email only
  cron.schedule(
    "0 9 * * *",
    async () => {
      try {
        await runDailyDigest();
      } catch (err) {
        logger.error(`[cron:dailyDigest] failed: ${err.message}`);
      }
    },
    { timezone: process.env.SERVER_TZ || "Asia/Karachi" },
  );

  logger.info("[smartOrders] cron jobs registered (daily digest)");
};

const runDailyDigest = async () => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const workspaces = await Workspace.find({ "smartOrders.enabled": true }).lean(false);

  for (const ws of workspaces) {
    try {
      const [newCount, totalRevenue, unconfirmed] = await Promise.all([
        Order.countDocuments({ workspaceId: ws._id, createdAt: { $gte: since24h } }),
        Order.aggregate([
          {
            $match: {
              workspaceId: ws._id,
              createdAt: { $gte: since24h },
              status: { $in: ["confirmed", "shipped", "delivered"] },
            },
          },
          { $group: { _id: null, total: { $sum: "$subtotal" } } },
        ]),
        Order.countDocuments({ workspaceId: ws._id, status: "new" }),
      ]);

      if (newCount === 0 && unconfirmed === 0) continue;

      // Email-only merchant notification handled by emailService elsewhere.
      logger.info(
        `[cron:dailyDigest] ws=${ws._id} newOrders=${newCount} revenue=${totalRevenue[0]?.total || 0} pending=${unconfirmed}`,
      );
    } catch (err) {
      logger.warn(`[cron:dailyDigest] workspace ${ws._id} failed: ${err.message}`);
    }
  }
  logger.info(`[cron:dailyDigest] processed ${workspaces.length} workspace(s)`);
};

module.exports = { startCrons };
