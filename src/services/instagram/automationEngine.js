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
const { DripCampaign, DripEnrollment } = require("../../models/DripCampaign");
const Giveaway = require("../../models/Giveaway");
const { sendDM } = require(".");
const { decrypt } = require("../../utils/encryption");
const logger = require("../../utils/logger");
const { planHasFeature, FEATURES } = require("../../config/plans");
const ai = require("../ai");
const legacyAi = require("../ai/openaiService"); // kept for transcribeAudio/captions only
const { dispatchEvent } = require("../webhookDispatcher");

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
    return contact;
  }
  // Refresh stale placeholder fields when we now have real values.
  let dirty = false;
  if (username && contact.igUsername === senderId) {
    contact.igUsername = username;
    contact.username = username;
    dirty = true;
  }
  if (name && (!contact.name || contact.name === "Instagram User")) {
    contact.name = name;
    dirty = true;
  }
  if (dirty) await contact.save();
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
    sender: "bot",
    type: "text",
    text: finalText,
    channelType: "instagram",
    status: result.success ? "sent" : "failed",
    failureReason: result.success ? undefined : result.error,
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
  // Read v2 aiSettings first, fall back to legacy aiBot for older installs.
  const aiCfg = workspace.aiSettings || workspace.aiBot || {};
  if (!aiCfg.enabled) return false;
  const maxTurns = aiCfg.maxTurnsPerConversation || 20;
  if ((conv.botReplyCount || 0) >= maxTurns) return false;

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

// ── Drip enrollment on keyword match ────────────────────────────────────────
const tryEnrollDripByKeyword = async (workspace, contact, text) => {
  if (!text) return;
  try {
    const campaigns = await DripCampaign.find({
      workspaceId: workspace._id,
      enabled: true,
      "trigger.type": "keyword",
    });
    for (const c of campaigns) {
      const kw = c.trigger?.keyword;
      if (!kw) continue;
      if (!text.toLowerCase().includes(kw.toLowerCase())) continue;

      const already = await DripEnrollment.findOne({
        campaignId: c._id,
        contactId: contact._id,
        status: "active",
      });
      if (already) continue;

      const firstDelay = c.steps[0]?.delayMinutes || 0;
      await DripEnrollment.create({
        workspaceId: workspace._id,
        campaignId: c._id,
        contactId: contact._id,
        currentStep: 0,
        nextRunAt: new Date(Date.now() + firstDelay * 60 * 1000),
        status: "active",
      });
      c.stats.enrolled = (c.stats.enrolled || 0) + 1;
      await c.save();
      logger.info(
        `[drip] Enrolled ${contact.igUsername} in campaign ${c.name}`,
      );
    }
  } catch (err) {
    logger.warn(`[drip] enroll error: ${err.message}`);
  }
};

// ── Giveaway participant tracking ───────────────────────────────────────────
const trackGiveawayEntry = async (
  workspace,
  postId,
  senderId,
  username,
  commentText,
  commentId,
) => {
  if (!postId) return;
  try {
    const active = await Giveaway.find({
      workspaceId: workspace._id,
      postId,
      status: "active",
      endsAt: { $gt: new Date() },
    });
    for (const g of active) {
      // Keyword filter if set
      if (
        g.entryKeyword &&
        !commentText?.toLowerCase().includes(g.entryKeyword.toLowerCase())
      ) {
        continue;
      }
      // Skip duplicates
      if (g.participants.some((p) => p.igUserId === senderId)) continue;
      g.participants.push({
        igUserId: senderId,
        igUsername: username,
        commentId,
        commentText,
        commentedAt: new Date(),
      });
      await g.save();
    }
  } catch (err) {
    logger.warn(`[giveaway] entry tracking error: ${err.message}`);
  }
};

// ── Sentiment enrichment ────────────────────────────────────────────────────
const enrichMessageSentiment = async (workspace, messageDoc, text) => {
  if (!workspace.sentimentAnalysis?.enabled || !text) return;
  try {
    const result = await legacyAi.analyzeSentiment(text);
    messageDoc.sentiment = result.sentiment;
    messageDoc.intent = result.intent;
    messageDoc.urgency = result.urgency;
    await messageDoc.save();
  } catch (err) {
    logger.debug(`[sentiment] ${err.message}`);
  }
};

// ── MAIN ENTRY ───────────────────────────────────────────────────────────────
const handleWebhookEvent = async (workspaceId, event) => {
  try {
    const workspace = await Workspace.findById(workspaceId).select(
      "+instagram.accessToken +instagram.igUserId +instagram.igBusinessAccountId",
    );
    if (!workspace) {
      logger.info(`[IG flow] no workspace for id=${workspaceId}`);
      return;
    }
    if (workspace.instagram?.status !== "connected") {
      logger.info(
        `[IG flow] ws=${workspaceId} not connected (status=${workspace.instagram?.status})`,
      );
      return;
    }
    if (!workspace.settings?.automationEnabled) {
      logger.info(`[IG flow] ws=${workspaceId} automationEnabled=false — drop`);
      return;
    }

    const { type, senderId, senderUsername, senderName, text } = event;
    if (!senderId) return;
    logger.info(
      `[IG flow] ws=${workspaceId} type=${type} sender=${senderId} text=${(text || "").slice(0, 60)}`,
    );

    try {
      const ownIgId = decrypt(workspace.instagram.igUserId);
      let ownIgBaId;
      try {
        if (workspace.instagram.igBusinessAccountId)
          ownIgBaId = decrypt(workspace.instagram.igBusinessAccountId);
      } catch {}
      if (senderId === ownIgId || senderId === ownIgBaId) return;
    } catch {}

    if (type === TRIGGERS.POST_COMMENT) {
      // Track giveaway entries (if any active on this post)
      if (event.postId) {
        await trackGiveawayEntry(
          workspace,
          event.postId,
          senderId,
          senderUsername,
          text,
          event.commentId,
        );
      }
      // Hide negative comments (if enabled)
      if (workspace.hideNegativeComments?.enabled && event.commentId) {
        try {
          const { hide, reason } = await legacyAi.moderateComment(
            text,
            workspace.hideNegativeComments.competitorNames || [],
          );
          if (hide) {
            const { hideComment } = require(".");
            if (typeof hideComment === "function") {
              const token = decrypt(workspace.instagram.accessToken);
              await hideComment(token, event.commentId).catch(() => {});
            }
            workspace.hideNegativeComments.hiddenCount =
              (workspace.hideNegativeComments.hiddenCount || 0) + 1;
            await workspace.save();
            logger.info(
              `[moderation] Hidden comment ${event.commentId}: ${reason}`,
            );
            return;
          }
        } catch (err) {
          logger.debug(`[moderation] ${err.message}`);
        }
      }

      // VIP Comment Prioritizer (B4) — flag comments from watched users.
      if (
        workspace.vipComments?.enabled &&
        senderUsername &&
        Array.isArray(workspace.vipComments.usernames) &&
        workspace.vipComments.usernames.length
      ) {
        const handle = String(senderUsername).toLowerCase().replace(/^@/, "");
        const isVip = workspace.vipComments.usernames.some(
          (u) => String(u).toLowerCase().replace(/^@/, "") === handle,
        );
        if (isVip) {
          try {
            const contact = await upsertContact(workspace._id, senderId, {
              username: senderUsername,
              source: "post_comment",
            });
            contact.tags = Array.from(
              new Set([...(contact.tags || []), "vip"]),
            );
            contact.isVip = true;
            await contact.save();
            workspace.vipComments.flaggedCount =
              (workspace.vipComments.flaggedCount || 0) + 1;
            await workspace.save();
            logger.info(
              `[VIP] Flagged comment from @${senderUsername} on post ${event.postId}`,
            );
            // Optional auto-DM to VIP
            const tmpl = workspace.vipComments.autoDmTemplate;
            if (tmpl) {
              const conv = await getOrCreateConversation(workspace, contact);
              await sendAndLog({
                workspace,
                contact,
                conversation: conv,
                text: tmpl,
                triggerType: "vip_reply",
              }).catch(() => {});
            }
          } catch (err) {
            logger.debug(`[VIP] ${err.message}`);
          }
        }
      }
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
          sender: "customer",
          type: "text",
          text,
          channelType: "instagram",
          status: "received",
          metadata: { inboundTriggerType: type },
        });
        conv.lastMessageAt = new Date();
        conv.lastMessagePreview = text.slice(0, 120);
        conv.unreadByAgentCount = (conv.unreadByAgentCount || 0) + 1;
        await conv.save();

        // Enrich with sentiment (async, non-blocking)
        const savedMsg = await Message.findOne({
          conversationId: conv._id,
          direction: "inbound",
        }).sort({ createdAt: -1 });
        if (savedMsg) {
          enrichMessageSentiment(workspace, savedMsg, text).catch(() => {});
        }

        // Try to enroll contact into a matching drip campaign
        tryEnrollDripByKeyword(workspace, contact, text).catch(() => {});

        // Fire outbound webhook: message.inbound
        dispatchEvent(workspace._id, "message.inbound", {
          contactId: contact._id,
          igUsername: contact.igUsername,
          text,
          type,
        }).catch(() => {});
      }

      logger.info(
        `[IG flow] ws=${workspace._id} entering trigger chain (botReplyCount=${conv.botReplyCount || 0})`,
      );

      if (type === TRIGGERS.POSTBACK) {
        if (await handlePostback(workspace, contact, conv, event.payload)) {
          logger.info(`[IG flow] handled by POSTBACK`);
          return;
        }
      }
      if (type === TRIGGERS.STORY_REPLY) {
        if (await handleStoryReply(workspace, contact, conv, text)) {
          logger.info(`[IG flow] handled by STORY_REPLY`);
          return;
        }
      }
      if (type === TRIGGERS.SHARE_TO_STORY) {
        if (await handleShare(workspace, contact, conv)) {
          logger.info(`[IG flow] handled by SHARE_TO_STORY`);
          return;
        }
      }
      if (await handleAwayReply(workspace, contact, conv)) {
        logger.info(`[IG flow] handled by AWAY_REPLY`);
        return;
      }
      if (text && (await handleDMKeyword(workspace, contact, conv, text))) {
        logger.info(`[IG flow] handled by DM_KEYWORD`);
        return;
      }
      if (text && (await handleAIReply(workspace, contact, conv, text))) {
        logger.info(`[IG flow] handled by AI_REPLY`);
        return;
      }
      const aiCfg = workspace.aiSettings || workspace.aiBot || {};
      logger.info(
        `[IG flow] AI did not handle (plan=${workspace.subscription?.plan} aiEnabled=${!!aiCfg.enabled} hasText=${!!text})`,
      );
      if (await handleWelcome(workspace, contact, conv)) {
        logger.info(`[IG flow] handled by WELCOME`);
        return;
      }
      await handleFallback(workspace, contact, conv);
      logger.info(`[IG flow] reached FALLBACK (or nothing)`);
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
