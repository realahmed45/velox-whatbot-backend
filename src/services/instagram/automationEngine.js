/**
 * Botlify — Instagram DM Automation Engine
 *
 * Handles every trigger we support:
 *   - POST_COMMENT          (webhook: comments)       → keywordTriggers
 *   - DIRECT_MESSAGE        (webhook: messages)       → welcome DM or dmKeywordTriggers or AI bot or fallback
 *   - DM_KEYWORD            (subset of DIRECT_MESSAGE) — keyword match on inbound DM
 *   - STORY_REPLY           (messages with reply-to story)
 *   - STORY_MENTION         (webhook: mentions)
 *   - SHARE_TO_STORY        (messages with attachment=share)
 *   - REF_URL               (messaging_referral)
 *   - POSTBACK              (messaging_postbacks)     → conversation starters
 *   - LIVE_COMMENT          (webhook: live_comments)
 *   - AI_REPLY              (fallback when Scale plan + ai_bot enabled)
 */

const Workspace = require("../../models/Workspace");
const Contact = require("../../models/Contact");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const { sendDM } = require("./metaService");
const { decrypt } = require("../../utils/encryption");
const logger = require("../../utils/logger");
const { planHasFeature, FEATURES } = require("../../config/plans");
const ai = require("../ai/openaiService");

const TRIGGERS = {
  POST_COMMENT: "post_comment",
  DIRECT_MESSAGE: "direct_message",
  DM_KEYWORD: "dm_keyword",
  STORY_REPLY: "story_reply",
  STORY_MENTION: "story_mention",
  SHARE_TO_STORY: "share_to_story",
  REF_URL: "ref_url",
  POSTBACK: "postback",
  LIVE_COMMENT: "live_comment",
  WELCOME: "welcome",
  FALLBACK: "fallback",
  AI_REPLY: "ai_reply",
};

// ── Utilities ────────────────────────────────────────────────────────────────
const personalize = (tpl, contact) => {
  const firstName = (
    contact?.name ||
    contact?.igUsername ||
    contact?.username ||
    "there"
  )
    .toString()
    .split(" ")[0];
  return (tpl || "")
    .replace(/\{name\}/gi, firstName)
    .replace(/\{first_name\}/gi, firstName)
    .replace(/\{username\}/gi, contact?.igUsername || contact?.username || "");
};

const matchKeyword = (text, kw, matchType = "contains") => {
  if (!text || !kw) return false;
  const a = text.toLowerCase().trim();
  const b = kw.toLowerCase().trim();
  return matchType === "exact" ? a === b : a.includes(b);
};

const isWithinBusinessHours = (workspace) => {
  const hours = workspace.businessHours || [];
  if (!hours.length) return true;
  const now = new Date();
  const days = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const today = hours.find((h) => h.day === days[now.getDay()]);
  if (!today || !today.isOpen) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const toMin = (s) => {
    const [h, m] = (s || "00:00").split(":").map(Number);
    return h * 60 + m;
  };
  return current >= toMin(today.openTime) && current <= toMin(today.closeTime);
};

const upsertContact = async (
  workspaceId,
  senderId,
  { username, name, source } = {},
) => {
  let contact = await Contact.findOne({ workspaceId, igUserId: senderId });
  if (!contact) {
    contact = await Contact.create({
      workspaceId,
      igUserId: senderId,
      igUsername: username || senderId,
      username: username || senderId,
      name: name || username || "Instagram User",
      source: source || "instagram",
      tags: [],
    });
  }
  return contact;
};

const getOrCreateConversation = async (
  workspace,
  contact,
  channel = "instagram",
) => {
  let conv = await Conversation.findOne({
    workspaceId: workspace._id,
    contactId: contact._id,
    channelType: channel,
  }).sort({ lastMessageAt: -1 });
  if (!conv) {
    conv = await Conversation.create({
      workspaceId: workspace._id,
      contactId: contact._id,
      channelType: channel,
      status: "bot_active",
      botEnabled: true,
      metadata: {},
    });
  }
  return conv;
};

const recentlyTriggered = async (
  conv,
  triggerType,
  keyword = null,
  hours = 24,
) => {
  const since = new Date(Date.now() - hours * 3600000);
  const filter = {
    conversationId: conv._id,
    direction: "outbound",
    createdAt: { $gte: since },
    "metadata.triggerType": triggerType,
  };
  if (keyword) filter["metadata.keyword"] = keyword;
  return await Message.exists(filter);
};

const sendAndLog = async ({
  workspace,
  contact,
  conversation,
  text,
  triggerType,
  keyword = null,
}) => {
  const limit = workspace.usage?.messagesLimit ?? 500;
  const used = workspace.usage?.messagesThisMonth ?? 0;
  if (limit > 0 && used >= limit && limit < 999999999) {
    logger.warn(`[Plan] ${workspace._id} hit DM limit ${used}/${limit}`);
    return { success: false, reason: "plan_limit" };
  }

  const accessToken = decrypt(workspace.instagram.accessToken);
  const finalText = personalize(text, contact);

  const brand =
    workspace.settings?.botlifyBrandingEnabled &&
    !planHasFeature(
      workspace.subscription?.plan || "starter",
      FEATURES.REMOVE_BRANDING,
    )
      ? "\n\n—\nSent via Botlify.app"
      : "";

  const result = await sendDM(accessToken, contact.igUserId, finalText + brand);

  await Message.create({
    workspaceId: workspace._id,
    conversationId: conversation._id,
    contactId: contact._id,
    direction: "outbound",
    channelType: "instagram",
    content: { type: "text", text: finalText },
    status: result.success ? "sent" : "failed",
    metadata: { triggerType, keyword, igMessageId: result.messageId },
  });

  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = finalText.slice(0, 120);
  conversation.lastBotMessageAt = new Date();
  conversation.botReplyCount = (conversation.botReplyCount || 0) + 1;
  conversation.metadata = {
    ...(conversation.metadata || {}),
    lastTriggerType: triggerType,
  };
  conversation.markModified("metadata");
  await conversation.save();

  await Workspace.updateOne(
    { _id: workspace._id },
    { $inc: { "usage.messagesThisMonth": 1 } },
  );

  contact.messageCount = (contact.messageCount || 0) + 1;
  contact.lastSeenAt = new Date();
  contact.lastTriggerType = triggerType;
  await contact.save();

  logger.info(
    `[Bot] ${triggerType} → @${contact.igUsername || contact.username} (ws=${workspace._id})`,
  );
  return { success: result.success };
};

const guardSend = (workspace, contact, conversation) => {
  if (!workspace.settings?.automationEnabled) return "automation_disabled";
  if (workspace.instagram?.status !== "connected") return "ig_disconnected";
  if (contact?.optedOut) return "contact_opted_out";
  if (conversation && conversation.botEnabled === false) return "bot_paused";
  return null;
};

// ── Individual trigger handlers ──────────────────────────────────────────────
const handlePostComment = async (
  workspace,
  senderId,
  commentText,
  commentMeta = {},
) => {
  const triggers = (workspace.keywordTriggers || []).filter((t) => t.enabled);
  const matched = triggers.find((t) =>
    matchKeyword(commentText, t.keyword, t.matchType),
  );
  if (!matched) return;

  const contact = await upsertContact(workspace._id, senderId, {
    username: commentMeta.username,
    name: commentMeta.username,
    source: "post_comment",
  });
  const conv = await getOrCreateConversation(workspace, contact);
  const blocked = guardSend(workspace, contact, conv);
  if (blocked) return logger.debug(`[handlePostComment] blocked: ${blocked}`);

  if (await recentlyTriggered(conv, TRIGGERS.POST_COMMENT, matched.keyword, 24))
    return;

  let body = matched.replyMessage;
  if (matched.ctaLabel && matched.ctaUrl)
    body += `\n\n👉 ${matched.ctaLabel}: ${matched.ctaUrl}`;

  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: body,
    triggerType: TRIGGERS.POST_COMMENT,
    keyword: matched.keyword,
  });
};

const handleDMKeyword = async (workspace, contact, conv, text) => {
  const triggers = (workspace.dmKeywordTriggers || []).filter((t) => t.enabled);
  const matched = triggers.find((t) =>
    matchKeyword(text, t.keyword, t.matchType),
  );
  if (!matched) return false;
  if (await recentlyTriggered(conv, TRIGGERS.DM_KEYWORD, matched.keyword, 1))
    return true;

  let body = matched.replyMessage;
  if (matched.ctaLabel && matched.ctaUrl)
    body += `\n\n👉 ${matched.ctaLabel}: ${matched.ctaUrl}`;
  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: body,
    triggerType: TRIGGERS.DM_KEYWORD,
    keyword: matched.keyword,
  });
  return true;
};

const handleWelcome = async (workspace, contact, conv) => {
  if (conv.botReplyCount > 0) return false;
  if (workspace.dmMessages?.enabled === false) return false;
  const greeting = workspace.dmMessages?.greeting;
  if (!greeting) return false;
  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: greeting,
    triggerType: TRIGGERS.WELCOME,
  });
  return true;
};

const handleStoryReply = async (workspace, contact, conv, text) => {
  const cfg = workspace.storyReplyTrigger;
  if (!cfg?.enabled) return false;
  if (!planHasFeature(workspace.subscription?.plan, FEATURES.STORY_REPLY))
    return false;
  if (await recentlyTriggered(conv, TRIGGERS.STORY_REPLY, null, 6)) return true;

  let message = cfg.replyMessage;
  const routed = (cfg.keywords || []).find((k) =>
    matchKeyword(text, k.keyword, k.matchType),
  );
  if (routed?.replyMessage) message = routed.replyMessage;

  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: message,
    triggerType: TRIGGERS.STORY_REPLY,
  });
  return true;
};

const handleStoryMention = async (workspace, senderId, meta = {}) => {
  const cfg = workspace.storyMentionTrigger;
  if (!cfg?.enabled) return;
  if (!planHasFeature(workspace.subscription?.plan, FEATURES.STORY_MENTION))
    return;

  const contact = await upsertContact(workspace._id, senderId, {
    username: meta.username,
    source: "story_mention",
  });
  const conv = await getOrCreateConversation(workspace, contact);
  const blocked = guardSend(workspace, contact, conv);
  if (blocked) return;
  if (await recentlyTriggered(conv, TRIGGERS.STORY_MENTION, null, 12)) return;

  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: cfg.replyMessage,
    triggerType: TRIGGERS.STORY_MENTION,
  });
};

const handleShare = async (workspace, contact, conv) => {
  const cfg = workspace.shareToStoryTrigger;
  if (!cfg?.enabled) return false;
  if (!planHasFeature(workspace.subscription?.plan, FEATURES.SHARE_TO_STORY))
    return false;
  if (await recentlyTriggered(conv, TRIGGERS.SHARE_TO_STORY, null, 6))
    return true;

  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: cfg.replyMessage,
    triggerType: TRIGGERS.SHARE_TO_STORY,
  });
  return true;
};

const handleRefUrl = async (workspace, senderId, refCode, meta = {}) => {
  if (!planHasFeature(workspace.subscription?.plan, FEATURES.REF_URL)) return;
  const trig = (workspace.refUrlTriggers || []).find(
    (t) => t.enabled && t.code === refCode,
  );
  if (!trig) return;

  const contact = await upsertContact(workspace._id, senderId, {
    username: meta.username,
    source: `ref_${refCode}`,
  });
  const conv = await getOrCreateConversation(workspace, contact);
  const blocked = guardSend(workspace, contact, conv);
  if (blocked) return;

  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: trig.replyMessage,
    triggerType: TRIGGERS.REF_URL,
    keyword: refCode,
  });
};

const handlePostback = async (workspace, contact, conv, payload) => {
  if (
    !planHasFeature(
      workspace.subscription?.plan,
      FEATURES.CONVERSATION_STARTERS,
    )
  )
    return false;
  const cfg = workspace.conversationStarters;
  if (!cfg?.enabled) return false;
  const opt = (cfg.options || []).find((o) => o.payload === payload);
  if (!opt) return false;
  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: opt.replyMessage,
    triggerType: TRIGGERS.POSTBACK,
    keyword: payload,
  });
  return true;
};

const handleLiveComment = async (workspace, senderId, text, meta = {}) => {
  if (!planHasFeature(workspace.subscription?.plan, FEATURES.LIVE_COMMENT))
    return;
  const matched = (workspace.liveCommentTriggers || []).find(
    (t) => t.enabled && matchKeyword(text, t.keyword, "contains"),
  );
  if (!matched) return;
  const contact = await upsertContact(workspace._id, senderId, {
    username: meta.username,
    source: "live_comment",
  });
  const conv = await getOrCreateConversation(workspace, contact);
  const blocked = guardSend(workspace, contact, conv);
  if (blocked) return;
  if (await recentlyTriggered(conv, TRIGGERS.LIVE_COMMENT, matched.keyword, 6))
    return;
  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: matched.replyMessage,
    triggerType: TRIGGERS.LIVE_COMMENT,
    keyword: matched.keyword,
  });
};

const handleAwayReply = async (workspace, contact, conv) => {
  if (!planHasFeature(workspace.subscription?.plan, FEATURES.BUSINESS_HOURS))
    return false;
  const cfg = workspace.awayReply;
  if (!cfg?.enabled) return false;
  if (isWithinBusinessHours(workspace)) return false;
  if (await recentlyTriggered(conv, "away_reply", null, 6)) return true;
  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: cfg.message,
    triggerType: "away_reply",
  });
  return true;
};

const handleAIReply = async (workspace, contact, conv, text) => {
  if (!planHasFeature(workspace.subscription?.plan, FEATURES.AI_BOT))
    return false;
  if (!workspace.aiBot?.enabled) return false;
  if (
    (conv.botReplyCount || 0) >= (workspace.aiBot.maxTurnsPerConversation || 20)
  )
    return false;

  const msgs = await Message.find({ conversationId: conv._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  const history = msgs
    .reverse()
    .map((m) => ({
      role: m.direction === "outbound" ? "assistant" : "user",
      content: m.content?.text || "",
    }))
    .filter((m) => m.content);

  const { reply, escalate } = await ai.generateReply({
    workspace,
    history,
    userMessage: text,
    contact,
  });

  if (escalate) {
    conv.status = "awaiting_human";
    await conv.save();
  }

  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: reply,
    triggerType: TRIGGERS.AI_REPLY,
  });
  return true;
};

const handleFallback = async (workspace, contact, conv) => {
  const cfg = workspace.fallbackReply;
  if (!cfg?.enabled) return false;
  const cooldown = cfg.cooldownHours || 24;
  if (await recentlyTriggered(conv, TRIGGERS.FALLBACK, null, cooldown))
    return true;
  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: cfg.message,
    triggerType: TRIGGERS.FALLBACK,
  });
  return true;
};

// ── MAIN ENTRY ───────────────────────────────────────────────────────────────
const handleWebhookEvent = async (workspaceId, event) => {
  try {
    const workspace = await Workspace.findById(workspaceId).select(
      "+instagram.accessToken +instagram.igUserId",
    );
    if (!workspace) return;
    if (workspace.instagram?.status !== "connected") return;
    if (!workspace.settings?.automationEnabled) return;

    const { type, senderId, senderUsername, senderName, text } = event;
    if (!senderId) return;

    try {
      const ownIgId = decrypt(workspace.instagram.igUserId);
      if (senderId === ownIgId) return;
    } catch {}

    if (type === TRIGGERS.POST_COMMENT) {
      await handlePostComment(workspace, senderId, text, {
        username: senderUsername,
      });
      return;
    }
    if (type === TRIGGERS.STORY_MENTION) {
      await handleStoryMention(workspace, senderId, {
        username: senderUsername,
      });
      return;
    }
    if (type === TRIGGERS.LIVE_COMMENT) {
      await handleLiveComment(workspace, senderId, text, {
        username: senderUsername,
      });
      return;
    }
    if (type === TRIGGERS.REF_URL) {
      await handleRefUrl(workspace, senderId, event.refCode, {
        username: senderUsername,
      });
      return;
    }

    if (
      type === TRIGGERS.DIRECT_MESSAGE ||
      type === TRIGGERS.STORY_REPLY ||
      type === TRIGGERS.SHARE_TO_STORY ||
      type === TRIGGERS.POSTBACK
    ) {
      const contact = await upsertContact(workspace._id, senderId, {
        username: senderUsername,
        name: senderName,
        source: type,
      });
      const conv = await getOrCreateConversation(workspace, contact);
      const blocked = guardSend(workspace, contact, conv);
      if (blocked) return;

      if (text) {
        await Message.create({
          workspaceId: workspace._id,
          conversationId: conv._id,
          contactId: contact._id,
          direction: "inbound",
          channelType: "instagram",
          content: { type: "text", text },
          status: "received",
          metadata: { inboundTriggerType: type },
        });
        conv.lastMessageAt = new Date();
        conv.lastMessagePreview = text.slice(0, 120);
        conv.unreadByAgentCount = (conv.unreadByAgentCount || 0) + 1;
        await conv.save();
      }

      if (type === TRIGGERS.POSTBACK) {
        if (await handlePostback(workspace, contact, conv, event.payload))
          return;
      }
      if (type === TRIGGERS.STORY_REPLY) {
        if (await handleStoryReply(workspace, contact, conv, text)) return;
      }
      if (type === TRIGGERS.SHARE_TO_STORY) {
        if (await handleShare(workspace, contact, conv)) return;
      }
      if (await handleAwayReply(workspace, contact, conv)) return;
      if (text && (await handleDMKeyword(workspace, contact, conv, text)))
        return;
      if (text && (await handleAIReply(workspace, contact, conv, text))) return;
      if (await handleWelcome(workspace, contact, conv)) return;
      await handleFallback(workspace, contact, conv);
      return;
    }
  } catch (err) {
    logger.error("handleWebhookEvent error", {
      err: err.message,
      stack: err.stack,
      workspaceId,
    });
  }
};

const processScheduledFollowups = async () => {
  return;
};

module.exports = {
  handleWebhookEvent,
  TRIGGERS,
  processScheduledFollowups,
  _internal: { personalize, matchKeyword, isWithinBusinessHours },
};
