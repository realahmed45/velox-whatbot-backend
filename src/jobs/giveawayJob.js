/**
 * Botlify — Giveaway Job
 * Closes giveaways past endsAt, picks random winners, DMs them.
 */
const Giveaway = require("../models/Giveaway");
const Workspace = require("../models/Workspace");
const { sendDM } = require("../services/instagram/metaService");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const personalize = (tpl, username) =>
  (tpl || "")
    .replace(/\{name\}/gi, username || "friend")
    .replace(/\{username\}/gi, username || "");

const processExpiredGiveaways = async () => {
  const now = new Date();
  const expiring = await Giveaway.find({
    status: "active",
    endsAt: { $lte: now },
  }).limit(20);

  for (const g of expiring) {
    try {
      g.status = "picking";
      await g.save();

      const pool = g.participants.filter(
        (p) => !g.winners.some((w) => w.igUserId === p.igUserId),
      );
      const count = Math.min(g.maxWinners, pool.length);
      const picked = pool.sort(() => Math.random() - 0.5).slice(0, count);
      for (const p of picked) {
        g.winners.push({
          igUserId: p.igUserId,
          igUsername: p.igUsername,
          pickedAt: new Date(),
        });
      }

      // DM winners
      const ws = await Workspace.findById(g.workspaceId).select(
        "+instagram.accessToken +instagram.igUserId",
      );
      if (ws?.instagram?.accessToken && g.winners.length) {
        const token = decrypt(ws.instagram.accessToken);
        for (const w of g.winners.filter((x) => !x.notified)) {
          try {
            await sendDM(
              token,
              w.igUserId,
              personalize(g.winnerDmMessage, w.igUsername),
            );
            w.notified = true;
          } catch (err) {
            logger.warn(`[giveaway] DM to ${w.igUsername} failed: ${err.message}`);
          }
        }
      }

      g.status = "completed";
      await g.save();
    } catch (err) {
      logger.warn(`[giveaway] ${g._id} processing failed: ${err.message}`);
      g.status = "active"; // let it retry
      await g.save();
    }
  }

  return { processed: expiring.length };
};

module.exports = { processExpiredGiveaways };
