const { Worker } = require("bullmq");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");

// Runs monthly to reset usage counters
module.exports = (connection) => {
  const worker = new Worker(
    "usage-reset",
    async (job) => {
      const { workspaceId } = job.data;
      if (workspaceId) {
        await Workspace.findByIdAndUpdate(workspaceId, {
          "usage.messagesThisMonth": 0,
        });
        logger.info(`[UsageReset] Reset usage for workspace ${workspaceId}`);
      } else {
        // Reset all active workspaces
        const result = await Workspace.updateMany(
          { "subscription.status": "active" },
          { "usage.messagesThisMonth": 0 },
        );
        logger.info(
          `[UsageReset] Reset usage for ${result.modifiedCount} workspaces`,
        );
      }
    },
    { connection },
  );

  worker.on("failed", (job, err) =>
    logger.error(`[UsageReset] Job ${job?.id} failed: ${err.message}`),
  );
  return worker;
};
