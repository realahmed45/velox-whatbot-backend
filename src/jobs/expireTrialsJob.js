/**
 * Auto-disconnect Instagram when a free trial ends without converting to paid.
 *
 * Why: the hosted provider (Zernio) bills us per connected account. If a trial
 * lapses and the user didn't pay, we must drop their Instagram connection so we
 * stop being charged for it. Paid ("active") and comped ("lifetime") accounts
 * are never touched — their connection must persist for life so customers never
 * have to reconnect.
 *
 * Runs on a daily cron (see server.js).
 */
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const { decrypt } = require("../utils/encryption");

async function expireTrials() {
  const now = new Date();

  // Trials that have lapsed and never converted. Explicitly EXCLUDE:
  //  - active/paid subscriptions (keep connected forever)
  //  - lifetime/comped accounts
  // and only touch workspaces that actually have a hosted IG connection.
  const workspaces = await Workspace.find({
    "subscription.status": "trialing",
    "subscription.trialEndsAt": { $lt: now },
    "subscription.lifetime": { $ne: true },
    "instagram.connectionType": "botlify_oauth",
    "instagram.status": "connected",
  }).select("+instagram.botlifyAccountId name subscription instagram");

  if (!workspaces.length) return;

  logger.info(
    `[expireTrials] ${workspaces.length} lapsed trial(s) to disconnect`,
  );

  const botlifyIg = require("../services/instagram/botlifyIgService");

  for (const ws of workspaces) {
    // Extra safety: never disconnect a paid or comped account, even if a query
    // race let one through.
    if (
      ws.subscription?.status === "active" ||
      ws.subscription?.lifetime === true
    ) {
      continue;
    }

    // 1. Drop the account on Zernio so we stop being billed for it.
    if (ws.instagram?.botlifyAccountId) {
      try {
        const acc = decrypt(ws.instagram.botlifyAccountId);
        await botlifyIg.disconnectAccount(acc);
      } catch (e) {
        logger.warn("[expireTrials] provider disconnect failed", {
          workspaceId: String(ws._id),
          err: e.message,
        });
        // continue — still clear our side so we don't retry forever
      }
    }

    // 2. Clear the connection on our side + lock the subscription.
    try {
      await Workspace.findByIdAndUpdate(ws._id, {
        $unset: {
          "instagram.igUserId": 1,
          "instagram.accessToken": 1,
          "instagram.pageId": 1,
          "instagram.sessionCookie": 1,
          "instagram.botlifyAccountId": 1,
          "instagram.igAccountHash": 1,
        },
        $set: {
          "instagram.status": "disconnected",
          // Lock the account until they pay (Botlify has no free tier).
          "subscription.status": "cancelled",
          "settings.automationEnabled": false,
        },
      });
      logger.info("[expireTrials] disconnected lapsed trial", {
        workspaceId: String(ws._id),
        name: ws.name,
      });
      try {
        const { record, EVENTS } = require("../services/adminEvents");
        record(EVENTS.TRIAL_EXPIRED, {
          workspaceId: ws._id,
          message: `${ws.name || "A workspace"}'s trial expired — Instagram auto-disconnected`,
        });
      } catch {
        /* best-effort */
      }
    } catch (e) {
      logger.warn("[expireTrials] workspace update failed", {
        workspaceId: String(ws._id),
        err: e.message,
      });
    }
  }
}

module.exports = { expireTrials };
