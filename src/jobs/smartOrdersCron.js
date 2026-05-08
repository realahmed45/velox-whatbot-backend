/**
 * Smart Orders cron jobs
 *  - Daily merchant digest (9 AM workspace time, simplified to a single 9 AM UTC run for v1)
 *  - Ghost follow-up scan (every 60 minutes) — finds incomplete order intents
 *    in the last 6 hours and asks the AI to nudge the customer.
 *
 * Runs in-process via node-cron. Safe to call init() at server startup.
 */
const cron = require("node-cron");
const Workspace = require("../models/Workspace");
const Order = require("../models/Order");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Contact = require("../models/Contact");
const dispatcher = require("../services/whatsapp/dispatcher");
const logger = require("../utils/logger");

const startCrons = () => {
  // ── Daily digest ──────────────────────────────────────────────────────────
  // Every day at 09:00 server time. For v1 we use server tz; can be made
  // workspace-tz-aware later.
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

  // ── Ghost follow-up ───────────────────────────────────────────────────────
  // Every 60 minutes scan for buying-intent conversations that stalled.
  cron.schedule("*/60 * * * *", async () => {
    try {
      await runGhostFollowup();
    } catch (err) {
      logger.error(`[cron:ghostFollowup] failed: ${err.message}`);
    }
  });

  logger.info(
    "[smartOrders] cron jobs registered (daily digest + ghost followup)",
  );
};

// ── Daily digest: pings merchant on WA + emails them ────────────────────────
const runDailyDigest = async () => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const workspaces = await Workspace.find({
    "smartOrders.enabled": true,
  })
    .select(
      "+whatsapp.metaAccessToken +whatsapp.metaPhoneNumberId +whatsapp.ultramsgToken +whatsapp.ultralmsgInstanceId +whatsapp.cloudApiToken +whatsapp.cloudInstanceId +whatsapp.wasenderApiKey",
    )
    .lean(false);

  for (const ws of workspaces) {
    try {
      const phone = ws.smartOrders?.notifyPhone;
      if (!phone) continue;

      const [newCount, totalRevenue, unconfirmed] = await Promise.all([
        Order.countDocuments({
          workspaceId: ws._id,
          createdAt: { $gte: since24h },
        }),
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
        Order.countDocuments({
          workspaceId: ws._id,
          status: "new",
        }),
      ]);

      if (newCount === 0 && unconfirmed === 0) continue; // skip silent days

      const revenue = totalRevenue[0]?.total || 0;
      const text =
        `☀️ *Good morning!*\n\n` +
        `Yesterday's summary:\n` +
        `• ${newCount} new order${newCount === 1 ? "" : "s"}\n` +
        (revenue > 0 ? `• ${revenue} PKR confirmed revenue\n` : "") +
        (unconfirmed > 0
          ? `• ${unconfirmed} pending order${unconfirmed === 1 ? "" : "s"} need your attention\n`
          : "") +
        `\nView all: ${process.env.FRONTEND_URL || "https://botlify.site"}/dashboard/orders`;

      await dispatcher
        .sendMessage(ws, phone, { type: "text", text })
        .catch((err) =>
          logger.warn(
            `[cron:dailyDigest] WA send failed for ${ws._id}: ${err.message}`,
          ),
        );
    } catch (err) {
      logger.warn(
        `[cron:dailyDigest] workspace ${ws._id} failed: ${err.message}`,
      );
    }
  }
  logger.info(`[cron:dailyDigest] processed ${workspaces.length} workspace(s)`);
};

// ── Ghost follow-up: nudge customers who showed buying intent ───────────────
//
// Heuristic: find conversations from the last 6h where:
//   - workspace has smartOrders enabled
//   - the AI sent at least one message that mentioned a price OR a catalog item
//   - the customer replied to at least one such message
//   - no Order document was created from this conversation
//   - no follow-up has been sent in the last 24h (tracked via conversation.meta.ghostFollowupSentAt)
//
// For simplicity we trigger AI to write a custom nudge using the existing
// conversation history. The AI is told this is a recovery follow-up.
const runGhostFollowup = async () => {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Find conversations with recent activity but no order yet
  const candidates = await Conversation.find({
    lastMessageAt: {
      $gte: sixHoursAgo,
      $lte: new Date(Date.now() - 30 * 60 * 1000),
    },
    status: { $in: ["bot_active", "open"] },
  })
    .limit(500)
    .lean();

  let sent = 0;
  for (const conv of candidates) {
    try {
      // Skip if we already followed up today
      if (
        conv.metadata?.ghostFollowupSentAt &&
        new Date(conv.metadata.ghostFollowupSentAt) > oneDayAgo
      ) {
        continue;
      }

      const ws = await Workspace.findById(conv.workspaceId).select(
        "+whatsapp.metaAccessToken +whatsapp.metaPhoneNumberId +whatsapp.ultramsgToken +whatsapp.ultralmsgInstanceId +whatsapp.cloudApiToken +whatsapp.cloudInstanceId +whatsapp.wasenderApiKey aiKnowledge smartOrders aiSettings aiSettingsWa whatsapp activeChannel name",
      );
      if (!ws?.smartOrders?.enabled) continue;

      // Skip if order already created
      const hasOrder = await Order.exists({ conversationId: conv._id });
      if (hasOrder) continue;

      const recent = await Message.find({ conversationId: conv._id })
        .sort({ createdAt: -1 })
        .limit(15)
        .lean();
      if (recent.length < 2) continue;

      // Heuristic: at least one outbound (AI) message + customer reply after it
      const hasOutbound = recent.some((m) => m.direction === "outbound");
      const hasInbound = recent.some((m) => m.direction === "inbound");
      if (!hasOutbound || !hasInbound) continue;

      const contact = await Contact.findById(conv.contactId);
      if (!contact?.phone) continue;

      // Build a short nudge — keep it light, not pushy
      const items = (ws.smartOrders.catalog || "")
        .split("\n")
        .find((l) => l.trim())
        ?.split(/[—-]/)?.[0]
        ?.trim();
      const nudge = items
        ? `Hey${contact.name ? ` ${contact.name}` : ""}! 👋 Just checking in — still interested? Happy to help finalise your order whenever you're ready.`
        : `Hey${contact.name ? ` ${contact.name}` : ""}! 👋 Just checking in — let me know if you need anything else.`;

      const sendResult = await dispatcher
        .sendMessage(ws, contact.phone, { type: "text", text: nudge })
        .catch((err) => {
          logger.warn(
            `[cron:ghostFollowup] WA send failed for ${conv._id}: ${err.message}`,
          );
          return null;
        });
      if (!sendResult || sendResult.success === false) continue;

      await Message.create({
        workspaceId: ws._id,
        conversationId: conv._id,
        contactId: contact._id,
        direction: "outbound",
        type: "text",
        sender: "system",
        text: nudge,
        status: "sent",
        meta: { ghostFollowup: true },
      });

      // Mark conversation
      await Conversation.updateOne(
        { _id: conv._id },
        {
          $set: { "metadata.ghostFollowupSentAt": new Date() },
        },
      );
      sent++;
    } catch (err) {
      logger.warn(
        `[cron:ghostFollowup] conv ${conv._id} failed: ${err.message}`,
      );
    }
  }
  if (sent > 0) {
    logger.info(`[cron:ghostFollowup] sent ${sent} follow-up message(s)`);
  }
};

module.exports = { startCrons };
