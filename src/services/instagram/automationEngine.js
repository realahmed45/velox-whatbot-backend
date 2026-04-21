/**
 * Botlify — Instagram DM Automation Engine
 * Triggers: post_comment (keyword match), direct_message
 * Sends greeting DM immediately on trigger
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

// ── Keyword match helper ──────────────────────────────────────────────────────
const matchesKeyword = (commentText, trigger) => {
  if (!commentText || !trigger.enabled) return false;
  const text = commentText.toLowerCase().trim();
  const kw = trigger.keyword.toLowerCase().trim();
  return trigger.matchType === "exact" ? text === kw : text.includes(kw);
};

// ── Main entry: handle incoming Instagram webhook event ───────────────────────
const handleWebhookEvent = async (workspaceId, event) => {
  try {
    const workspace = await Workspace.findById(workspaceId).select(
      "+instagram.accessToken +instagram.igUserId",
    );
    if (!workspace || workspace.instagram?.status !== "connected") return;
    if (!workspace.settings?.automationEnabled) return;

    const { type, senderId, senderUsername, senderName, text } = event;

    // Don't DM yourself
    const ownIgId = decrypt(workspace.instagram.igUserId);
    if (senderId === ownIgId) return;

    // ── Comment trigger: check against keyword triggers ───────────────────────
    if (type === TRIGGERS.POST_COMMENT) {
      const matched = (workspace.keywordTriggers || []).find((t) =>
        matchesKeyword(text, t),
      );
      if (!matched) return; // comment doesn't match any keyword — ignore

      logger.info(
        `[Keyword] Comment "${text}" matched keyword "${matched.keyword}" for workspace ${workspaceId}`,
      );

      // Find or create contact
      let contact = await Contact.findOne({ workspaceId, igUserId: senderId });
      if (!contact) {
        contact = await Contact.create({
          workspaceId,
          igUserId: senderId,
          username: senderUsername || senderId,
          name: senderName || senderUsername || "Instagram User",
          source: "keyword_comment",
          tags: [],
        });
      }

      // Dedup: don't re-trigger same keyword within 24h
      const recentKeyword = await Conversation.findOne({
        workspaceId,
        contactId: contact._id,
        "metadata.triggerType": TRIGGERS.KEYWORD_DM,
        "metadata.keyword": matched.keyword,
        createdAt: { $gte: new Date(Date.now() - 24 * 3600000) },
      });
      if (recentKeyword) {
        logger.debug(`Dedup: @${senderUsername} already triggered keyword "${matched.keyword}" recently`);
        return;
      }

      logger.info(`Sending keyword DM to @${senderUsername || senderId} for keyword "${matched.keyword}"`);
      await sendKeywordDM(workspace, contact, matched);
      return;
    }

    // ── Direct message trigger: auto-reply ────────────────────────────────────
    if (type !== TRIGGERS.DIRECT_MESSAGE) return;

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

    // Send greeting DM immediately (no delay)
    logger.info(`Sending greeting DM to @${senderUsername || senderId}`);
    await sendGreetingDM(workspace, contact, type);
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

// ── Send keyword-triggered DM ─────────────────────────────────────────────────
const sendKeywordDM = async (workspace, contact, trigger) => {
  const accessToken = decrypt(workspace.instagram.accessToken);
  const firstName = (contact.name || contact.username).split(" ")[0];
  const text = trigger.replyMessage.replace(/\{name\}/gi, firstName);

  const result = await sendDM(accessToken, contact.igUserId, text);

  const conversation = await Conversation.create({
    workspaceId: workspace._id,
    contactId: contact._id,
    channelType: "instagram",
    status: "open",
    metadata: {
      triggerType: TRIGGERS.KEYWORD_DM,
      keyword: trigger.keyword,
      followUpStep: 0, // no follow-ups for keyword DMs (one-shot reply)
    },
  });

  await Message.create({
    workspaceId: workspace._id,
    conversationId: conversation._id,
    contactId: contact._id,
    direction: "outbound",
    channelType: "instagram",
    content: { type: "text", text },
    status: result.success ? "sent" : "failed",
    metadata: { igMessageId: result.messageId },
  });

  logger.info(`Keyword DM sent to @${contact.username} (keyword: "${trigger.keyword}")`);
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

// ── Follower polling ──────────────────────────────────────────────────────────
// Instagram Graph API does NOT provide a /me/followers endpoint.
// New-follower DM automation via polling is not possible with the Instagram API.
// Automation is triggered by: incoming DMs and post comments (via webhooks).
const pollNewFollowers = async () => {
  // No-op: Instagram API doesn't support fetching follower lists
  logger.debug(
    "[Poller] pollNewFollowers: skipped — Instagram API does not expose followers list",
  );
};

module.exports = {
  handleWebhookEvent,
  TRIGGERS,
  processScheduledFollowups,
  pollNewFollowers,
};
