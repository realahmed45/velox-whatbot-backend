/**
 * Botlify — Instagram DM Automation Engine
 * Triggers: new_follower, post_like
 * Sends greeting DM after random delay (min–max minutes)
 * Sends 3 follow-ups at N-hour intervals if no reply
 */
const Workspace = require("../../models/Workspace");
const Contact = require("../../models/Contact");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const { sendDM, getRecentFollowers } = require("./metaService");
const { decrypt } = require("../../utils/encryption");
const logger = require("../../utils/logger");

const TRIGGERS = {
  NEW_FOLLOWER: "new_follower",
  POST_LIKE: "post_like",
  STORY_MENTION: "story_mention",
  POST_COMMENT: "post_comment",
  KEYWORD_DM: "keyword_dm",
  DIRECT_MESSAGE: "direct_message",
};

// ── Main entry: handle incoming Instagram webhook event ───────────────────────
const handleWebhookEvent = async (workspaceId, event) => {
  try {
    const workspace = await Workspace.findById(workspaceId).select(
      "+instagram.accessToken +instagram.igUserId",
    );
    if (!workspace || workspace.instagram?.status !== "connected") return;
    if (!workspace.settings?.automationEnabled) return;

    const { type, senderId, senderUsername, senderName } = event;

    // Only handle follower and like triggers for DM automation
    if (
      ![
        TRIGGERS.NEW_FOLLOWER,
        TRIGGERS.POST_LIKE,
        TRIGGERS.DIRECT_MESSAGE,
      ].includes(type)
    )
      return;

    // Don't DM yourself
    const ownIgId = decrypt(workspace.instagram.igUserId);
    if (senderId === ownIgId) return;

    // Find or create contact
    let contact = await Contact.findOne({ workspaceId, igUserId: senderId });
    if (!contact) {
      contact = await Contact.create({
        workspaceId,
        igUserId: senderId,
        username: senderUsername || senderId,
        name: senderName || senderUsername || "Instagram User",
        source: type,
        tags: [],
      });
    }

    // Dedup: don't re-trigger greeting within 24h for same trigger type
    const recent = await Conversation.findOne({
      workspaceId,
      contactId: contact._id,
      "metadata.triggerType": type,
      createdAt: { $gte: new Date(Date.now() - 24 * 3600000) },
    });
    if (recent) {
      logger.debug(
        `Dedup: @${senderUsername} already triggered ${type} recently`,
      );
      return;
    }

    // Schedule greeting DM after random delay (min–max minutes)
    const minMs = (workspace.settings?.minDelayMinutes ?? 3) * 60000;
    const maxMs = (workspace.settings?.maxDelayMinutes ?? 15) * 60000;
    const delayMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

    logger.info(
      `Scheduling greeting DM to @${senderUsername} in ${Math.round(delayMs / 60000)}min`,
    );

    setTimeout(async () => {
      try {
        await sendGreetingDM(workspace, contact, type);
      } catch (err) {
        logger.error("Greeting DM error", { err: err.message });
      }
    }, delayMs);
  } catch (err) {
    logger.error("handleWebhookEvent error", { err: err.message, workspaceId });
  }
};

// ── Send greeting DM and create conversation ──────────────────────────────────
const sendGreetingDM = async (workspace, contact, triggerType) => {
  const accessToken = decrypt(workspace.instagram.accessToken);
  const igUserId = decrypt(workspace.instagram.igUserId);
  const firstName = (contact.name || contact.username).split(" ")[0];

  const greetingText = (
    workspace.dmMessages?.greeting || "Hey {name}! 👋 Thanks for following!"
  ).replace(/\{name\}/gi, firstName);

  const result = await sendDM(accessToken, contact.igUserId, greetingText);

  const followUpIntervalMs =
    (workspace.dmMessages?.followUpIntervalHours ?? 3) * 3600000;

  const conversation = await Conversation.create({
    workspaceId: workspace._id,
    contactId: contact._id,
    channelType: "instagram",
    status: "open",
    metadata: {
      triggerType,
      followUpStep: 1,
      nextFollowupAt: new Date(Date.now() + followUpIntervalMs),
    },
  });

  await Message.create({
    workspaceId: workspace._id,
    conversationId: conversation._id,
    contactId: contact._id,
    direction: "outbound",
    channelType: "instagram",
    content: { type: "text", text: greetingText },
    status: result.success ? "sent" : "failed",
    metadata: { igMessageId: result.messageId },
  });

  logger.info(`Greeting DM sent to @${contact.username}`);
};

// ── Follow-up scheduler (called by cron job every 30 mins) ───────────────────
const processScheduledFollowups = async () => {
  const pending = await Conversation.find({
    channelType: "instagram",
    status: "open",
    "metadata.followUpStep": { $in: [1, 2, 3] },
    "metadata.nextFollowupAt": { $lte: new Date() },
  }).populate("contactId");

  for (const conv of pending) {
    try {
      const hasReplied = await Message.exists({
        conversationId: conv._id,
        direction: "inbound",
      });
      if (hasReplied) {
        conv.status = "resolved";
        conv.metadata.followUpStep = 0;
        conv.markModified("metadata");
        await conv.save();
        continue;
      }

      const workspace = await Workspace.findById(conv.workspaceId).select(
        "+instagram.accessToken +instagram.igUserId",
      );
      if (!workspace || workspace.instagram?.status !== "connected") continue;
      if (!workspace.settings?.automationEnabled) continue;

      const accessToken = decrypt(workspace.instagram.accessToken);
      const igUserId = decrypt(workspace.instagram.igUserId);
      const contact = conv.contactId;
      const firstName = (contact.name || contact.username).split(" ")[0];
      const step = conv.metadata.followUpStep;

      const msgs = [
        workspace.dmMessages?.followUp1 || "Hey {name}, just checking in! 😊",
        workspace.dmMessages?.followUp2 ||
          "Hi {name}! Happy to help with anything!",
        workspace.dmMessages?.followUp3 ||
          "Hey {name}, last message from me — I'm here whenever you're ready! 🙌",
      ];

      const text = (msgs[step - 1] || "").replace(/\{name\}/gi, firstName);
      if (!text.trim()) continue;

      const result = await sendDM(accessToken, contact.igUserId, text);

      await Message.create({
        workspaceId: workspace._id,
        conversationId: conv._id,
        contactId: contact._id,
        direction: "outbound",
        channelType: "instagram",
        content: { type: "text", text },
        status: result.success ? "sent" : "failed",
        metadata: { igMessageId: result.messageId, followUpStep: step },
      });

      const intervalMs =
        (workspace.dmMessages?.followUpIntervalHours ?? 3) * 3600000;
      const nextStep = step + 1;

      if (nextStep > 3) {
        conv.status = "resolved";
        conv.metadata.followUpStep = 0;
      } else {
        conv.metadata.followUpStep = nextStep;
        conv.metadata.nextFollowupAt = new Date(Date.now() + intervalMs);
      }
      conv.markModified("metadata");
      await conv.save();

      logger.info(`Follow-up ${step} sent to @${contact.username}`);
    } catch (err) {
      logger.error("Follow-up error", { convId: conv._id, err: err.message });
    }
  }
};

// ── Follower polling (fallback when webhook doesn't deliver follow events) ────
// Called every 10 minutes by node-cron in server.js
// Fetches the most recent followers via API and triggers automation for new ones
const pollNewFollowers = async () => {
  try {
    const workspaces = await Workspace.find({
      "instagram.status": "connected",
      "settings.automationEnabled": true,
    }).select("+instagram.accessToken +instagram.igUserId");

    for (const ws of workspaces) {
      try {
        const accessToken = decrypt(ws.instagram.accessToken);
        const followers = await getRecentFollowers(accessToken, 50);

        for (const follower of followers) {
          const followerId = String(follower.id);
          // Skip if we already know this contact
          const existing = await Contact.exists({
            workspaceId: ws._id,
            igUserId: followerId,
          });
          if (existing) continue;

          logger.info(
            `[Poller] New follower detected: ${follower.username || followerId} → workspace ${ws._id}`,
          );

          const event = {
            type: TRIGGERS.NEW_FOLLOWER,
            senderId: followerId,
            senderUsername: follower.username || null,
            senderName: null,
          };
          await handleWebhookEvent(ws._id, event);
        }
      } catch (err) {
        logger.error("[Poller] Error polling workspace", {
          workspaceId: ws._id,
          err: err.message,
        });
      }
    }
  } catch (err) {
    logger.error("[Poller] pollNewFollowers error", { err: err.message });
  }
};

module.exports = {
  handleWebhookEvent,
  TRIGGERS,
  processScheduledFollowups,
  pollNewFollowers,
};
