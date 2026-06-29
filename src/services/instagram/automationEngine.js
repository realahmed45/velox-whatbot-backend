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
const Flow = require("../../models/Flow");
const { sendDM } = require(".");
const { decrypt } = require("../../utils/encryption");
const logger = require("../../utils/logger");
const { planHasFeature, FEATURES } = require("../../config/plans");
const ai = require("../ai");
const legacyAi = require("../ai/openaiService"); // kept for transcribeAudio/captions only
const { dispatchEvent } = require("../webhookDispatcher");
const mailchimp = require("../mailchimpService");

// ── Mailchimp auto-subscribe helper ─────────────────────────────────────────
// Called non-blocking (fire-and-forget). Loads the workspace's Mailchimp
// config, decrypts the API key, and subscribes the email address. Silently
// swallows all errors so it never blocks or crashes the bot reply.
const autoSubscribeToMailchimp = async (workspace, { email, firstName, lastName } = {}) => {
  try {
    // Re-fetch workspace with the encrypted apiKey (selected: false by default)
    const ws = await Workspace.findById(workspace._id).select(
      "+integrations.mailchimp.apiKey",
    );
    const m = ws?.integrations?.mailchimp;
    if (!m?.apiKey || !m?.listId) return; // not configured — nothing to do

    const result = await mailchimp.subscribe(
      decrypt(m.apiKey),
      m.serverPrefix,
      m.listId,
      { email, firstName, lastName, source: "Botlify/Instagram-DM" },
    );
    if (result.ok) {
      logger.info(`[mailchimp] subscribed ${email} to list ${m.listId} (duplicate=${!!result.duplicate})`);
    } else {
      logger.warn(`[mailchimp] subscribe failed for ${email}: ${result.error}`);
    }
  } catch (err) {
    logger.warn(`[mailchimp] autoSubscribe error: ${err.message}`);
  }
};

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
  switch (matchType) {
    case "exact":
      return a === b;
    case "starts_with":
      return a.startsWith(b);
    case "ends_with":
      return a.endsWith(b);
    default:
      return a.includes(b);
  }
};

// Normalize a stored business-hours row to a canonical shape. We tolerate both
// the model shape ({ day:"monday", isOpen, openTime, closeTime }) and the older
// UI shape ({ day:"mon", enabled, start, end }) so saved schedules always work.
const DAY_ALIASES = {
  sun: "sunday",
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
};
const normalizeHoursRow = (row = {}) => {
  const rawDay = String(row.day || "").toLowerCase();
  const day = DAY_ALIASES[rawDay] || rawDay;
  const isOpen = row.isOpen ?? row.enabled ?? false;
  const openTime = row.openTime || row.start || "09:00";
  const closeTime = row.closeTime || row.end || "17:00";
  return { day, isOpen, openTime, closeTime };
};

const isWithinBusinessHours = (workspace) => {
  // If the merchant hasn't switched on business hours, treat as always-open so
  // the away reply never fires unexpectedly.
  if (!workspace.settings?.businessHoursEnabled) return true;
  const hours = (workspace.businessHours || []).map(normalizeHoursRow);
  if (!hours.length) return true;

  // Evaluate "now" in the workspace timezone when one is configured.
  const tz = workspace.timezone || workspace.settings?.timezone;
  let now = new Date();
  if (tz) {
    try {
      now = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    } catch {
      /* invalid tz — fall back to server time */
    }
  }

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

// Contact.source is a strict channel enum. Callers pass granular trigger
// origins (e.g. "post_comment", "story_mention", "ref_SUMMER") which are NOT
// valid enum values — passing them straight through threw a ValidationError
// and silently killed every automation. Normalize to the channel and stash the
// granular origin in `acquisitionTrigger`.
const VALID_CONTACT_SOURCES = new Set([
  "instagram",
  "messenger",
  "telegram",
  "manual",
  "import",
]);

const upsertContact = async (
  workspaceId,
  senderId,
  { username, name, profilePic, source } = {},
) => {
  const channelSource = VALID_CONTACT_SOURCES.has(source)
    ? source
    : "instagram";
  const acquisitionTrigger =
    source && !VALID_CONTACT_SOURCES.has(source) ? source : undefined;

  let contact = await Contact.findOne({ workspaceId, igUserId: senderId });
  if (!contact) {
    contact = await Contact.create({
      workspaceId,
      igUserId: senderId,
      igUsername: username || senderId,
      username: username || senderId,
      name: name || username || "Instagram User",
      igProfilePic: profilePic || undefined,
      source: channelSource,
      acquisitionTrigger,
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
  if (profilePic && !contact.igProfilePic) {
    contact.igProfilePic = profilePic;
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
  imageUrls = [],
}) => {
  // Simulate mode (Bot Tester): compute the reply but never hit the IG API or
  // touch usage quota. We still collect the reply text into __outbox so the
  // tester UI can show it inline.
  const simulate = !!workspace.__simulate;

  if (!simulate) {
    const limit = workspace.usage?.messagesLimit ?? 500;
    const used = workspace.usage?.messagesThisMonth ?? 0;
    if (limit > 0 && used >= limit && limit < 999999999) {
      logger.warn(`[Plan] ${workspace._id} hit DM limit ${used}/${limit}`);
      return { success: false, reason: "plan_limit" };
    }
  }

  const finalText = personalize(text, contact);

  const brand =
    workspace.settings?.botlifyBrandingEnabled &&
    !planHasFeature(
      workspace.subscription?.plan || "starter",
      FEATURES.REMOVE_BRANDING,
    )
      ? "\n\n—\nSent via Botlify.app"
      : "";

  let result;
  if (simulate) {
    result = { success: true, messageId: "simulated" };
    if (Array.isArray(workspace.__outbox)) workspace.__outbox.push(finalText);
  } else {
    const accessToken = decrypt(workspace.instagram.accessToken);
    const convId = conversation.metadata?.providerConversationId;
    logger.info(`[sendDM] ws=${workspace._id} recipient=${contact.igUserId} convId=${convId || "none"} trigger=${triggerType}`);
    result = await sendDM(accessToken, contact.igUserId, finalText + brand, {
      conversationId: convId,
    });
    logger.info(`[sendDM] result: success=${result.success} msgId=${result.messageId || "n/a"} err=${result.error || "none"}`);
  }

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

  // Send any images the AI chose to attach (e.g. the menu) as follow-up
  // messages, so the customer gets the text reply first, then the visual.
  const images = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
  for (const imageUrl of images.slice(0, 3)) {
    let imgResult;
    if (simulate) {
      imgResult = { success: true, messageId: "simulated" };
      if (Array.isArray(workspace.__outbox))
        workspace.__outbox.push(`[image] ${imageUrl}`);
    } else {
      const accessToken = decrypt(workspace.instagram.accessToken);
      const convId = conversation.metadata?.providerConversationId;
      imgResult = await sendDM(accessToken, contact.igUserId, "", {
        conversationId: convId,
        mediaUrl: imageUrl,
      });
      logger.info(
        `[sendDM:image] success=${imgResult.success} err=${imgResult.error || "none"}`,
      );
    }
    await Message.create({
      workspaceId: workspace._id,
      conversationId: conversation._id,
      contactId: contact._id,
      direction: "outbound",
      sender: "bot",
      type: "image",
      mediaUrl: imageUrl,
      channelType: "instagram",
      status: imgResult.success ? "sent" : "failed",
      failureReason: imgResult.success ? undefined : imgResult.error,
      metadata: { triggerType, igMessageId: imgResult.messageId },
    });
  }

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

  if (!simulate) {
    await Workspace.updateOne(
      { _id: workspace._id },
      { $inc: { "usage.messagesThisMonth": 1 } },
    );
  }

  contact.messageCount = (contact.messageCount || 0) + 1;
  contact.lastSeenAt = new Date();
  contact.lastTriggerType = triggerType;
  await contact.save();

  // Dispatch dm.sent webhook event (non-blocking)
  if (!simulate) {
    dispatchEvent(workspace._id, "dm.sent", {
      contactId: contact._id,
      igUsername: contact.igUsername,
      text: finalText,
      triggerType,
    }).catch(() => {});
  }

  logger.info(
    `[Bot] ${triggerType} → @${contact.igUsername || contact.username} (ws=${workspace._id})`,
  );
  return { success: result.success };
};

const guardSend = (workspace, contact, conversation) => {
  // In simulate mode (Bot Tester) we bypass workspace-level toggles so the
  // creator can preview replies even before automation is switched on.
  if (workspace.__simulate) return null;
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

  if (await recentlyTriggered(conv, TRIGGERS.POST_COMMENT, matched.keyword, 0.002))
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

  // Dispatch comment.received webhook event (non-blocking)
  dispatchEvent(workspace._id, "comment.received", {
    contactId: contact._id,
    igUsername: contact.igUsername || commentMeta.username,
    text: commentText,
    keyword: matched.keyword,
    type: "post_comment",
  }).catch(() => {});
};

const handleDMKeyword = async (workspace, contact, conv, text) => {
  const triggers = (workspace.dmKeywordTriggers || []).filter((t) => t.enabled);
  const matched = triggers.find((t) =>
    matchKeyword(text, t.keyword, t.matchType),
  );
  if (!matched) return false;
  if (await recentlyTriggered(conv, TRIGGERS.DM_KEYWORD, matched.keyword, 0.002))
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
  if (await recentlyTriggered(conv, TRIGGERS.STORY_REPLY, null, 0.002)) return true;

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
  if (await recentlyTriggered(conv, TRIGGERS.STORY_MENTION, null, 0.002)) return;

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
  if (await recentlyTriggered(conv, TRIGGERS.SHARE_TO_STORY, null, 0.002))
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

// Increment monthly AI bot stats, resetting at the start of a new month.
const bumpAiStats = async (workspace, { faq, handoff, lead }) => {
  const now = new Date();
  const last = workspace.aiStats?.monthlyResetAt
    ? new Date(workspace.aiStats.monthlyResetAt)
    : null;
  const sameMonth =
    last &&
    last.getMonth() === now.getMonth() &&
    last.getFullYear() === now.getFullYear();

  if (!sameMonth) {
    await Workspace.updateOne(
      { _id: workspace._id },
      {
        $set: {
          "aiStats.repliesThisMonth": 1,
          "aiStats.faqHits": faq ? 1 : 0,
          "aiStats.handoffs": handoff ? 1 : 0,
          "aiStats.leadsCaptured": lead ? 1 : 0,
          "aiStats.monthlyResetAt": now,
          "aiStats.lastReplyAt": now,
        },
      },
    );
    return;
  }

  await Workspace.updateOne(
    { _id: workspace._id },
    {
      $inc: {
        "aiStats.repliesThisMonth": 1,
        "aiStats.faqHits": faq ? 1 : 0,
        "aiStats.handoffs": handoff ? 1 : 0,
        "aiStats.leadsCaptured": lead ? 1 : 0,
      },
      $set: { "aiStats.lastReplyAt": now },
    },
  );
};

const handleAIReply = async (workspace, contact, conv, text) => {
  const plan = workspace.subscription?.plan || "free";
  if (!planHasFeature(plan, FEATURES.AI_BOT)) {
    logger.info(`[AI] ws=${workspace._id} plan=${plan} has no AI_BOT feature — skip`);
    return false;
  }
  // Read v2 aiSettings first, fall back to legacy aiBot for older installs.
  const aiCfg = workspace.aiSettings || workspace.aiBot || {};
  // Only an explicit OFF disables the bot. Missing `enabled` (legacy/partial
  // docs) is treated as ON so a workspace that has AI knowledge still replies.
  if (aiCfg.enabled === false) {
    logger.info(`[AI] ws=${workspace._id} aiSettings.enabled=false — skip`);
    return false;
  }
  const maxTurns = aiCfg.maxTurnsPerConversation || 200;
  if (maxTurns > 0 && (conv.botReplyCount || 0) >= maxTurns) {
    logger.info(`[AI] ws=${workspace._id} maxTurns=${maxTurns} reached — skip`);
    return false;
  }

  const msgs = await Message.find({ conversationId: conv._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
  const history = msgs
    .reverse()
    .map((m) => ({
      role: m.direction === "outbound" ? "assistant" : "user",
      content: m.text || m.content?.text || "",
    }))
    .filter((m) => m.content);

  // Pull live Shopify data (order status / matching products) for this message.
  let extraContext = null;
  try {
    const shopifyAssist = require("../integrations/shopifyAssist");
    extraContext = await shopifyAssist.buildContext(workspace, text, contact);
  } catch (e) {
    logger.warn(`[IG flow] shopifyAssist failed: ${e.message}`);
  }

  logger.info(`[AI] ws=${workspace._id} calling generateReply provider=${aiCfg.provider || "auto"} text="${(text || "").slice(0, 60)}"`);

  const { reply, escalate, provider, imageUrls } = await ai.generateReply({
    workspace,
    history,
    userMessage: text,
    contact,
    extraContext,
    channel: "instagram",
  });

  logger.info(`[AI] ws=${workspace._id} reply="${(reply || "").slice(0, 80)}" provider=${provider} escalate=${!!escalate}`);

  if (escalate) {
    conv.status = "awaiting_human";
    await conv.save();
  }

  // Track value metrics + Mailchimp auto-subscribe (skip in Bot Tester / simulate mode).
  if (!workspace.__simulate) {
    const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
    const PHONE_RE = /(\+?\d[\d\s\-()]{7,}\d)/;
    const capturedEmail = (text.match(EMAIL_RE) || [])[0] || null;
    const isLead =
      !!aiCfg.leadCapture && (!!capturedEmail || PHONE_RE.test(text));

    // Persist captured email to the contact record (first time only)
    if (capturedEmail && !contact.email) {
      try {
        contact.email = capturedEmail.toLowerCase();
        await contact.save();
        logger.info(`[AI] captured email ${capturedEmail} for contact ${contact._id}`);
      } catch (err) {
        logger.warn(`[AI] email save failed: ${err.message}`);
      }
    }

    // Auto-forward email to Mailchimp audience (if connected)
    if (capturedEmail) {
      const nameParts = (contact.name || "").trim().split(" ");
      autoSubscribeToMailchimp(workspace, {
        email: capturedEmail,
        firstName: nameParts[0] || "",
        lastName: nameParts.slice(1).join(" ") || "",
      }).catch(() => {});
    }

    // Dispatch lead.created webhook event when a lead is captured
    if (isLead) {
      dispatchEvent(workspace._id, "lead.created", {
        contactId: contact._id,
        igUsername: contact.igUsername,
        email: capturedEmail || null,
        hasPhone: PHONE_RE.test(text),
      }).catch(() => {});
    }

    bumpAiStats(workspace, {
      faq: provider === "faq",
      handoff: !!escalate,
      lead: isLead,
    }).catch(() => {});
  }

  // Smart Orders — strip the hidden order block before sending
  let outboundText = reply;
  try {
    const smartOrders = require("../smartOrders");
    const parsed = smartOrders.parseAiOrderBlock(reply);
    outboundText = parsed.cleanReply || reply;
    if (parsed.orderData) {
      await smartOrders.persistOrder({
        workspace,
        contact,
        conversation: conv,
        channel: "instagram",
        orderData: parsed.orderData,
      });
    }
  } catch (_) {
    /* never block reply on order parsing */
  }

  await sendAndLog({
    workspace,
    contact,
    conversation: conv,
    text: outboundText,
    triggerType: TRIGGERS.AI_REPLY,
    imageUrls: imageUrls || [],
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

// ── Visual Flow execution engine ─────────────────────────────────────────────
// Runs flows built in the drag-and-drop Flow Builder against inbound DMs. A flow
// is a graph of nodes connected by edges. We find a matching trigger node, then
// walk the graph executing action nodes (send text/image, tag, delay, ask a
// question, branch on a condition). Multi-step flows that wait for the user's
// reply persist their resume point on the conversation (`metadata.activeFlow`).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const renderVars = (tpl, variables = {}) =>
  (tpl || "").replace(/\{\{?\s*(\w+)\s*\}?\}/g, (m, k) =>
    variables[k] !== undefined ? variables[k] : m,
  );

const flowNodeById = (flow, id) => flow.nodes.find((n) => n.id === id);

const flowNextNode = (flow, nodeId, handle) => {
  const edges = flow.edges.filter((e) => e.source === nodeId);
  // When a handle (e.g. condition true/false) is given, prefer the matching edge
  const edge =
    (handle != null &&
      edges.find((e) => (e.sourceHandle || e.label) === handle)) ||
    edges[0];
  return edge ? flowNodeById(flow, edge.target) : null;
};

const TRIGGER_NODE_TYPES = new Set([
  "keyword_trigger",
  "any_message_trigger",
  "keyword_match",
  "keyword_dm",
  "any_message",
  "first_message",
  "direct_message",
  "story_mention",
  "post_comment",
  "story_reply",
  "button_click",
]);

const isFlowTriggerNode = (n) =>
  n.type === "trigger" || TRIGGER_NODE_TYPES.has(n.nodeType);

const flowTriggerMatches = (node, { text, isFirstMessage }) => {
  const nt = node.nodeType;
  if (nt === "first_message") return !!isFirstMessage;
  if (
    nt === "any_message" ||
    nt === "any_message_trigger" ||
    nt === "direct_message"
  )
    return true;
  if (nt === "keyword_trigger" || nt === "keyword_match" || nt === "keyword_dm") {
    const kws = node.data?.keywords || [];
    const mt = node.data?.matchType || "contains";
    if (!kws.length) return false;
    return kws.some((k) => matchKeyword(text, k, mt));
  }
  return false;
};

const parseFlowOptions = (data = {}) => {
  if (Array.isArray(data.buttons) && data.buttons.length) {
    return data.buttons.map((b, i) => ({
      label: b.label || b.title || `Option ${i + 1}`,
      nextNodeId: b.nextNodeId,
    }));
  }
  if (Array.isArray(data.listSections) && data.listSections.length) {
    return data.listSections
      .flatMap((s) => s.rows || [])
      .map((r) => ({ label: r.title, nextNodeId: r.nextNodeId }));
  }
  const raw = data.buttonsJson || data.itemsJson;
  if (raw) {
    return String(raw)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((label) => ({ label }));
  }
  return [];
};

const evalCondition = (left, op, right) => {
  const a = String(left ?? "").toLowerCase();
  const b = String(right ?? "").toLowerCase();
  const na = parseFloat(left),
    nb = parseFloat(right);
  switch (op) {
    case "equals":
      return a === b;
    case "not_equals":
    case "not_contains":
      return op === "not_equals" ? a !== b : !a.includes(b);
    case "contains":
      return a.includes(b);
    case "starts_with":
      return a.startsWith(b);
    case "ends_with":
      return a.endsWith(b);
    case "greater_than":
      return !isNaN(na) && !isNaN(nb) && na > nb;
    case "less_than":
      return !isNaN(na) && !isNaN(nb) && na < nb;
    default:
      return false;
  }
};

const executeFlowNode = async (flow, node, ctx) => {
  const { workspace, contact, conv, variables } = ctx;
  const d = node.data || {};
  const send = (text) =>
    sendAndLog({
      workspace,
      contact,
      conversation: conv,
      text,
      triggerType: "flow",
      keyword: String(flow._id),
    });

  switch (node.nodeType) {
    case "send_text": {
      const msg = renderVars(d.message || d.content || d.text, variables);
      if (msg) await send(msg);
      return { next: true };
    }
    case "send_image": {
      const url = d.imageUrl || d.url;
      const caption = renderVars(d.caption || d.content || "", variables);
      const text = [caption, url].filter(Boolean).join("\n");
      if (text) await send(text);
      return { next: true };
    }
    case "send_file": {
      const url = d.fileUrl || d.url;
      const text = [renderVars(d.content || "", variables), url]
        .filter(Boolean)
        .join("\n");
      if (text) await send(text);
      return { next: true };
    }
    case "tag_contact": {
      const tag = d.tagName || d.tag;
      if (tag) {
        contact.tags = Array.from(new Set([...(contact.tags || []), tag]));
        await contact.save();
      }
      return { next: true };
    }
    case "assign_agent": {
      conv.status = "awaiting_human";
      conv.botEnabled = false;
      await conv.save();
      const note = renderVars(d.agentNote || "", variables);
      if (note) {
        conv.metadata = { ...(conv.metadata || {}), agentNote: note };
        conv.markModified("metadata");
        await conv.save();
      }
      return { next: true };
    }
    case "delay": {
      // Inline delays are capped so we never hold the webhook open too long.
      const secs = Math.min(Math.max(Number(d.delaySeconds) || 0, 0), 8);
      if (secs > 0) await sleep(secs * 1000);
      return { next: true };
    }
    case "ask_question": {
      const q = renderVars(d.questionText || d.content || d.message, variables);
      if (q) await send(q);
      return {
        await: {
          kind: "question",
          variableName: d.variableName || "answer",
          nodeId: node.id,
        },
      };
    }
    case "button_menu":
    case "list_menu": {
      const body = renderVars(d.content || d.message || "", variables);
      const options = parseFlowOptions(d);
      const menu = [
        body,
        ...options.map((o, i) => `${i + 1}. ${o.label}`),
      ]
        .filter(Boolean)
        .join("\n");
      if (menu) await send(menu);
      return { await: { kind: "choice", nodeId: node.id } };
    }
    case "condition": {
      const left =
        variables[d.conditionVariable || d.variable] ?? "";
      const op = d.conditionOperator || d.operator || "equals";
      const right = d.conditionValue ?? d.value ?? "";
      const ok = evalCondition(left, op, right);
      return { next: true, handle: ok ? "true" : "false" };
    }
    case "end_flow":
      return { stop: true };
    default:
      return { next: true };
  }
};

const executeFlow = async (flow, startNode, ctx) => {
  const { conv, variables } = ctx;
  let current = startNode;
  let guard = 0;
  while (current && guard++ < 60) {
    let res;
    try {
      res = await executeFlowNode(flow, current, ctx);
    } catch (e) {
      logger.warn(`[flow] node ${current.id} error: ${e.message}`);
      res = { next: true };
    }
    if (res.stop) break;
    if (res.await) {
      conv.metadata = {
        ...(conv.metadata || {}),
        variables,
        activeFlow: {
          flowId: String(flow._id),
          awaiting: res.await.kind,
          variableName: res.await.variableName,
          nodeId: res.await.nodeId,
        },
      };
      conv.markModified("metadata");
      await conv.save();
      return; // wait for the user's reply
    }
    current = flowNextNode(flow, current.id, res.handle);
  }
  // Flow finished — clear resume state and bump completions.
  conv.metadata = {
    ...(conv.metadata || {}),
    variables,
    activeFlow: null,
  };
  conv.markModified("metadata");
  await conv.save();
  await Flow.updateOne(
    { _id: flow._id },
    { $inc: { "stats.completions": 1 } },
  ).catch(() => {});

  // Dispatch flow.completed webhook event (non-blocking)
  const { contact: _c, workspace: _ws } = ctx;
  if (_ws && !_ws.__simulate) {
    dispatchEvent(_ws._id, "flow.completed", {
      flowId: String(flow._id),
      flowName: flow.name || "",
      contactId: _c?._id,
      igUsername: _c?.igUsername,
    }).catch(() => {});
  }
};

// Resume a multi-step flow that was waiting for the contact's reply.
const resumePendingFlow = async (workspace, contact, conv, text) => {
  const af = conv.metadata?.activeFlow;
  if (!af?.awaiting) return false;

  const flow = await Flow.findOne({
    _id: af.flowId,
    workspaceId: workspace._id,
  });
  if (!flow || flow.status !== "active") {
    conv.metadata = { ...(conv.metadata || {}), activeFlow: null };
    conv.markModified("metadata");
    await conv.save();
    return false;
  }

  const variables = { ...(conv.metadata?.variables || {}) };
  const waitingNode = flowNodeById(flow, af.nodeId);
  let nextNode = null;

  if (af.awaiting === "question") {
    variables[af.variableName || "answer"] = text;
    nextNode = flowNextNode(flow, af.nodeId);
  } else if (af.awaiting === "choice") {
    const options = parseFlowOptions(waitingNode?.data || {});
    const idx = parseInt(text, 10);
    let chosen;
    if (!isNaN(idx) && idx >= 1 && idx <= options.length)
      chosen = options[idx - 1];
    else chosen = options.find((o) => matchKeyword(text, o.label, "contains"));
    if (chosen?.nextNodeId) nextNode = flowNodeById(flow, chosen.nextNodeId);
    else nextNode = flowNextNode(flow, af.nodeId);
  }

  conv.metadata = { ...(conv.metadata || {}), activeFlow: null, variables };
  conv.markModified("metadata");
  await conv.save();

  if (nextNode) await executeFlow(flow, nextNode, { workspace, contact, conv, variables });
  return true;
};

// Match an inbound message against active flows; execute the first that fires.
const runActiveFlows = async (workspace, contact, conv, { text }) => {
  const flows = await Flow.find({
    workspaceId: workspace._id,
    status: "active",
    channel: { $in: ["instagram", "all"] },
  }).sort({ priority: -1, updatedAt: -1 });
  if (!flows.length) return false;

  const isFirstMessage = (conv.botReplyCount || 0) === 0;

  for (const flow of flows) {
    const triggers = (flow.nodes || []).filter(isFlowTriggerNode);
    const matched = triggers.find((t) =>
      flowTriggerMatches(t, { text, isFirstMessage }),
    );
    if (!matched) continue;

    const startNode = flowNextNode(flow, matched.id);
    if (!startNode) continue; // trigger with no action wired

    await Flow.updateOne(
      { _id: flow._id },
      {
        $inc: { "stats.totalTriggers": 1 },
        $set: { "stats.lastTriggeredAt": new Date() },
      },
    ).catch(() => {});

    const variables = {
      name: (contact.name || contact.igUsername || "there")
        .toString()
        .split(" ")[0],
      username: contact.igUsername || contact.username || "",
      ...(conv.metadata?.variables || {}),
    };
    await executeFlow(flow, startNode, { workspace, contact, conv, variables });
    return true;
  }
  return false;
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

    // Bot Tester: run the full engine but skip real sends / toggles. The
    // collected replies are pushed into event.__outbox (shared by reference).
    if (event.simulate) {
      workspace.__simulate = true;
      workspace.__outbox = Array.isArray(event.__outbox) ? event.__outbox : [];
    }

    if (!workspace.__simulate) {
      if (workspace.instagram?.status !== "connected") {
        logger.info(
          `[IG flow] ws=${workspaceId} not connected (status=${workspace.instagram?.status})`,
        );
        return;
      }
      if (!workspace.settings?.automationEnabled) {
        logger.info(
          `[IG flow] ws=${workspaceId} automationEnabled=false — drop`,
        );
        return;
      }
    }

    const {
      type,
      senderId,
      senderUsername,
      senderName,
      senderProfilePic,
      providerConversationId,
      text,
    } = event;
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
        profilePic: senderProfilePic,
        source: type,
      });
      const conv = await getOrCreateConversation(workspace, contact);

      // Persist Zernio's conversation id so the bot can reply into this thread.
      if (
        providerConversationId &&
        conv.metadata?.providerConversationId !== providerConversationId
      ) {
        conv.metadata = {
          ...(conv.metadata || {}),
          providerConversationId,
        };
        conv.markModified("metadata");
        await conv.save();
      }

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

        // Fire outbound webhook: dm.received (Make.com / Zapier)
        dispatchEvent(workspace._id, "dm.received", {
          contactId: contact._id,
          igUsername: contact.igUsername,
          text,
          type,
        }).catch(() => {});

        // Also fire comment.received for story replies so Make can distinguish
        if (type === TRIGGERS.STORY_REPLY) {
          dispatchEvent(workspace._id, "comment.received", {
            contactId: contact._id,
            igUsername: contact.igUsername,
            text,
            type: "story_reply",
          }).catch(() => {});
        }
      }

      logger.info(
        `[IG flow] ws=${workspace._id} entering trigger chain (botReplyCount=${conv.botReplyCount || 0})`,
      );

      // Auto-reset botReplyCount if the last bot message was >24h ago — treat
      // it as a fresh conversation session so the AI limit never silently cuts off
      // a returning customer.
      if (
        conv.botReplyCount > 0 &&
        conv.lastBotMessageAt &&
        Date.now() - new Date(conv.lastBotMessageAt).getTime() > 24 * 60 * 60 * 1000
      ) {
        conv.botReplyCount = 0;
        logger.info(`[IG flow] ws=${workspace._id} botReplyCount reset (24h gap)`);
      }

      // 0. Resume a multi-step visual flow that's waiting on this reply.
      if (text && conv.metadata?.activeFlow?.awaiting) {
        if (await resumePendingFlow(workspace, contact, conv, text)) {
          logger.info(`[IG flow] handled by FLOW (resume)`);
          return;
        }
      }

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

      // 1. Active visual flows take priority over the default automations.
      if (await runActiveFlows(workspace, contact, conv, { text })) {
        logger.info(`[IG flow] handled by FLOW (trigger)`);
        return;
      }

      if (await handleAwayReply(workspace, contact, conv)) {
        logger.info(`[IG flow] handled by AWAY_REPLY`);
        return;
      }
      if (text && (await handleDMKeyword(workspace, contact, conv, text))) {
        logger.info(`[IG flow] handled by DM_KEYWORD`);
        return;
      }
      // Welcome greeting fires on the very first message, before AI takes over.
      if (await handleWelcome(workspace, contact, conv)) {
        logger.info(`[IG flow] handled by WELCOME`);
        return;
      }
      if (text && (await handleAIReply(workspace, contact, conv, text))) {
        logger.info(`[IG flow] handled by AI_REPLY`);
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
