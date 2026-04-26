/**
 * Follower polling job (Instagram has no follow webhook).
 * Runs every 6 hours, fetches followers_count for each connected workspace,
 * and appends to `followerHistory` if changed. Caps history at 180 entries.
 */
const Workspace = require("../models/Workspace");
const { getIGAccountInfo } = require("../services/instagram/metaService");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const MAX_HISTORY = 180;

const pollFollowers = async () => {
  const workspaces = await Workspace.find({
    "instagram.status": "connected",
  }).select("+instagram.accessToken");

  let ok = 0;
  let failed = 0;

  for (const ws of workspaces) {
    try {
      const token = decrypt(ws.instagram.accessToken);
      const info = await getIGAccountInfo(token);
      const count = Number(info?.followers_count || 0);
      if (!count && count !== 0) continue;

      const history = ws.followerHistory || [];
      const last = history[history.length - 1];

      // Only append if count differs or >6h since last entry
      const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
      const shouldAppend =
        !last ||
        last.count !== count ||
        new Date(last.at).getTime() < sixHoursAgo;

      if (shouldAppend) {
        history.push({ count, at: new Date() });
        if (history.length > MAX_HISTORY)
          history.splice(0, history.length - MAX_HISTORY);
      }

      ws.instagram.followersCount = count;
      ws.followerHistory = history;
      await ws.save();
      ok++;
    } catch (err) {
      failed++;
      logger.warn(
        `[followerPolling] workspace ${ws._id} failed: ${err.message}`,
      );
    }
  }

  if (ok || failed) {
    logger.info(`[followerPolling] ok=${ok} failed=${failed}`);
  }
};

module.exports = { pollFollowers };
