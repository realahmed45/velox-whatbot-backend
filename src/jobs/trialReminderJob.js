/**
 * Trial-ending reminder job.
 *
 * Runs daily. Finds trialing workspaces whose trial ends within the next ~24h
 * and emails the owner a "your trial ends soon" nudge (once). We mark each
 * workspace with subscription.trialReminderSentAt so we never email twice for
 * the same trial.
 */
const Workspace = require("../models/Workspace");
const { sendTrialEndingEmail } = require("../services/emailService");
const logger = require("../utils/logger");

async function sendTrialReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Trialing workspaces ending within the next 24h that we haven't reminded.
  const workspaces = await Workspace.find({
    "subscription.status": "trialing",
    "subscription.trialEndsAt": { $gte: now, $lte: in24h },
    "subscription.trialReminderSentAt": { $in: [null, undefined] },
  }).populate("owner", "name email");

  logger.info(`[TrialReminder] ${workspaces.length} trials ending soon`);
  let sent = 0;
  for (const ws of workspaces) {
    const owner = ws.owner;
    if (!owner?.email) continue;
    try {
      await sendTrialEndingEmail({
        to: owner.email,
        name: owner.name,
        trialEndsDate: ws.subscription.trialEndsAt,
        planName:
          ws.subscription.plan === "ig_pro" ? "Instagram Pro" : "Basic plan",
      });
      await Workspace.findByIdAndUpdate(ws._id, {
        "subscription.trialReminderSentAt": now,
      });
      sent++;
    } catch (err) {
      logger.warn(
        `[TrialReminder] failed for ws ${ws._id}: ${err.message}`,
      );
    }
  }
  logger.info(`[TrialReminder] done. sent:${sent}`);
  return { checked: workspaces.length, sent };
}

module.exports = { sendTrialReminders };
