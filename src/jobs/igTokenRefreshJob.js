const { Worker, Queue } = require("bullmq");
const Workspace = require("../models/Workspace");
const ig = require("../services/instagram");
const { encrypt, decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const QUEUE_NAME = "ig-token-refresh";
const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

async function refreshExpiringTokens() {
  const cutoff = new Date(Date.now() + REFRESH_WINDOW_MS);
  const workspaces = await Workspace.find({
    "instagram.status": "connected",
    "instagram.tokenExpiresAt": { $lte: cutoff },
  }).select("+instagram.accessToken");

  logger.info(`[IGTokenRefresh] checking ${workspaces.length} workspaces`);
  let ok = 0;
  let fail = 0;
  for (const ws of workspaces) {
    try {
      const token = decrypt(ws.instagram.accessToken);
      const result = await ig.refreshLongLivedToken(token);
      if (result?.access_token) {
        ws.instagram.accessToken = encrypt(result.access_token);
        if (result.expires_in) {
          ws.instagram.tokenExpiresAt = new Date(
            Date.now() + result.expires_in * 1000,
          );
        }
        await ws.save();
        ok++;
      } else {
        fail++;
      }
    } catch (err) {
      fail++;
      logger.error(
        `[IGTokenRefresh] failed for workspace ${ws._id}: ${err.message}`,
      );
    }
  }
  logger.info(`[IGTokenRefresh] done. ok:${ok} fail:${fail}`);
  return { ok, fail };
}

module.exports = (connection) => {
  const queue = new Queue(QUEUE_NAME, { connection });
  const worker = new Worker(QUEUE_NAME, async () => refreshExpiringTokens(), {
    connection,
    concurrency: 1,
  });
  worker.on("failed", (_job, err) =>
    logger.error(`[IGTokenRefresh] job failed: ${err.message}`),
  );
  queue
    .add(
      "daily",
      {},
      {
        repeat: { pattern: "15 3 * * *" },
        removeOnComplete: 10,
        removeOnFail: 25,
      },
    )
    .catch((e) =>
      logger.warn(`[IGTokenRefresh] schedule failed: ${e.message}`),
    );
  logger.info("[IGTokenRefresh] worker started, scheduled daily 03:15 UTC");
  return { queue, worker };
};

module.exports.refreshExpiringTokens = refreshExpiringTokens;
