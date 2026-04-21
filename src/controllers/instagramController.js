/**
 * Botlify — Instagram Controller
 * Uses Instagram API with Instagram Login (not Facebook Login)
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const Workspace = require("../models/Workspace");
const ig = require("../services/instagram/metaService");
const {
  handleWebhookEvent,
} = require("../services/instagram/automationEngine");
const { encrypt, decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const IG_APP_ID = process.env.IG_APP_ID;
const IG_APP_SECRET = process.env.IG_APP_SECRET;
const REDIRECT_URI = process.env.IG_OAUTH_REDIRECT_URI;
const WEBHOOK_VERIFY_TOKEN =
  process.env.IG_WEBHOOK_VERIFY_TOKEN || "botlify_webhook_2026";

// ── GET /api/instagram/connect/oauth-url ─────────────────────────────────────
// Instagram Business Login — goes straight to Instagram, no Facebook in the middle
exports.getOAuthUrl = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const state = Buffer.from(
    JSON.stringify({ workspaceId, userId: req.user._id }),
  ).toString("base64");

  const scopes = [
    "instagram_business_basic",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
    "instagram_business_content_publish",
  ].join(",");

  const url =
    `https://www.instagram.com/oauth/authorize` +
    `?enable_fb_login=0&force_authentication=1` +
    `&client_id=${IG_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${scopes}` +
    `&state=${state}`;

  res.json({ url });
});

// ── GET /api/instagram/connect/callback ──────────────────────────────────────
exports.oauthCallback = asyncHandler(async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    logger.warn("Instagram OAuth error", { error, error_description });
    return res.redirect(`${process.env.CLIENT_URL}/dashboard?error=cancelled`);
  }

  let workspaceId;
  try {
    ({ workspaceId } = JSON.parse(Buffer.from(state, "base64").toString()));
  } catch {
    return res.redirect(
      `${process.env.CLIENT_URL}/dashboard?error=invalid_state`,
    );
  }

  try {
    // Exchange code → short-lived IG token (1 hour)
    const shortTokenData = await ig.exchangeCodeForToken(code, REDIRECT_URI);
    const shortToken = shortTokenData.access_token;
    const igUserId = String(shortTokenData.user_id);

    // Upgrade to long-lived token (60 days)
    const longTokenData = await ig.getLongLivedToken(shortToken);
    const longToken = longTokenData.access_token;
    const expiresIn = longTokenData.expires_in || 60 * 24 * 3600;

    // Fetch profile info using the long-lived token
    const igInfo = await ig.getIGAccountInfo(longToken);

    // Subscribe the IG account to webhook events
    let webhookSubscribed = false;
    let webhookError = null;
    try {
      await ig.subscribeWebhook(longToken);
      webhookSubscribed = true;
    } catch (e) {
      webhookError = e.response?.data?.error?.message || e.message;
      logger.warn("Webhook subscribe failed at connect", {
        err: e.response?.data || e.message,
      });
    }

    await Workspace.findByIdAndUpdate(workspaceId, {
      "instagram.status": "connected",
      "instagram.connectionType": "meta_oauth",
      "instagram.igUserId": encrypt(igUserId),
      "instagram.accessToken": encrypt(longToken),
      "instagram.username": igInfo.username,
      "instagram.displayName": igInfo.name || igInfo.username,
      "instagram.profilePicture": igInfo.profile_picture_url,
      "instagram.followersCount": igInfo.followers_count,
      "instagram.connectedAt": new Date(),
      "instagram.tokenExpiresAt": new Date(Date.now() + expiresIn * 1000),
      "instagram.webhookSubscribed": webhookSubscribed,
      "instagram.webhookError": webhookError,
      "settings.automationEnabled": true,
      onboardingCompleted: true,
    });

    return res.redirect(
      `${process.env.CLIENT_URL}/dashboard?connected=true${webhookSubscribed ? "" : "&webhook=failed"}`,
    );
  } catch (err) {
    logger.error("Instagram OAuth callback failed", {
      err: err.response?.data || err.message,
    });
    return res.redirect(
      `${process.env.CLIENT_URL}/dashboard?error=oauth_failed`,
    );
  }
});

// ── POST /api/instagram/connect/session ──────────────────────────────────────
exports.connectBySession = asyncHandler(async (req, res) => {
  const { sessionCookie } = req.body;
  const workspaceId = req.headers["x-workspace-id"];
  if (!sessionCookie)
    return res.status(400).json({ message: "sessionCookie required" });

  await Workspace.findByIdAndUpdate(workspaceId, {
    "instagram.status": "connected",
    "instagram.connectionType": "session_cookie",
    "instagram.sessionCookie": encrypt(sessionCookie),
    "instagram.connectedAt": new Date(),
    onboardingCompleted: true,
  });

  res.json({
    success: true,
    message: "Session cookie saved. Bot will connect on next cycle.",
  });
});

// ── DELETE /api/instagram/connect ────────────────────────────────────────────
exports.disconnect = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  await Workspace.findByIdAndUpdate(workspaceId, {
    $unset: {
      "instagram.igUserId": 1,
      "instagram.accessToken": 1,
      "instagram.pageId": 1,
      "instagram.sessionCookie": 1,
    },
    "instagram.status": "disconnected",
  });
  res.json({ success: true });
});

// ── GET /api/instagram/connection ────────────────────────────────────────────
exports.getConnection = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const workspace = await Workspace.findById(workspaceId).select("instagram");
  const ig = workspace?.instagram || {};
  res.json({
    status: ig.status || "disconnected",
    connectionType: ig.connectionType,
    username: ig.username,
    displayName: ig.displayName,
    profilePicture: ig.profilePicture,
    followersCount: ig.followersCount,
    connectedAt: ig.connectedAt,
    tokenExpiresAt: ig.tokenExpiresAt,
  });
});

// ── GET /api/instagram/webhook (verification) ─────────────────────────────────
exports.verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    logger.info("Instagram webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
};

// ── POST /api/instagram/webhook (events) ─────────────────────────────────────
exports.receiveWebhook = asyncHandler(async (req, res) => {
  // req.body is a raw Buffer (express.raw middleware is applied on this route in server.js)
  const rawBody = req.body;

  // Always log that Meta hit us — crucial for debugging "nothing fires".
  logger.info(
    `[IG webhook] inbound ${Buffer.isBuffer(rawBody) ? rawBody.length : 0}B sig=${req.headers["x-hub-signature-256"] ? "present" : "missing"}`,
  );

  // Verify Meta signature using the raw Buffer
  const sig = req.headers["x-hub-signature-256"];
  if (sig && IG_APP_SECRET) {
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", IG_APP_SECRET)
        .update(rawBody) // ← must use raw Buffer, not stringified JSON
        .digest("hex");
    if (sig !== expected) {
      logger.warn("Instagram webhook signature mismatch");
      return res.sendStatus(403);
    }
  }

  res.sendStatus(200); // respond fast to Meta

  // Parse the raw Buffer into a JS object
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    logger.warn("Instagram webhook: malformed JSON body");
    return;
  }

  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    const entryIgUserId = String(entry.id);
    const entryTypes = [];
    if (entry.messaging?.length) entryTypes.push("messaging");
    if (entry.changes?.length)
      entryTypes.push(...entry.changes.map((c) => c.field).filter(Boolean));

    const workspaces = await Workspace.find({
      "instagram.status": "connected",
    }).select("+instagram.igUserId +instagram.accessToken");

    for (const ws of workspaces) {
      let wsIgId;
      try {
        wsIgId = decrypt(ws.instagram.igUserId);
      } catch {
        continue;
      }
      if (wsIgId !== entryIgUserId) continue;

      // Record that Meta is actually delivering events to us (visible in diagnose)
      Workspace.updateOne(
        { _id: ws._id },
        {
          $set: {
            "instagram.lastWebhookAt": new Date(),
            "instagram.lastWebhookType": entryTypes.join(",") || "unknown",
          },
        },
      ).catch(() => {});

      // ── Messaging events (DMs, story replies, shares, postbacks, referrals) ──
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        if (!senderId || senderId === wsIgId) continue;

        // Postback (conversation starter / CTA button click)
        if (msg.postback) {
          await handleWebhookEvent(ws._id, {
            type: "postback",
            senderId,
            payload: msg.postback.payload,
            text: msg.postback.title,
          });
          continue;
        }

        // Referral (ref URL deep link)
        if (msg.referral) {
          await handleWebhookEvent(ws._id, {
            type: "ref_url",
            senderId,
            refCode: msg.referral.ref,
          });
          continue;
        }

        const message = msg.message || {};

        // Story reply
        if (message.reply_to?.story) {
          await handleWebhookEvent(ws._id, {
            type: "story_reply",
            senderId,
            text: message.text,
            storyId: message.reply_to.story.id,
          });
          continue;
        }

        // Share (attachment type=share / story_mention)
        const attachments = message.attachments || [];
        const isShare = attachments.some((a) =>
          ["share", "story_mention", "template"].includes(a.type),
        );
        if (isShare) {
          await handleWebhookEvent(ws._id, {
            type: "share_to_story",
            senderId,
            text: message.text,
          });
          continue;
        }

        // Plain direct message
        await handleWebhookEvent(ws._id, {
          type: "direct_message",
          senderId,
          senderUsername: null,
          senderName: null,
          text: message.text,
        });
      }

      // ── Change events (comments, mentions, live_comments) ────────────────────
      for (const change of entry.changes || []) {
        const field = change.field;
        const v = change.value || {};

        if (field === "comments") {
          await handleWebhookEvent(ws._id, {
            type: "post_comment",
            senderId: v.from?.id,
            senderUsername: v.from?.username,
            text: v.text,
            postId: v.media?.id,
          });
        } else if (field === "mentions" || field === "story_mentions") {
          await handleWebhookEvent(ws._id, {
            type: "story_mention",
            senderId: v.from?.id || v.sender_id,
            senderUsername: v.from?.username,
          });
        } else if (field === "live_comments") {
          await handleWebhookEvent(ws._id, {
            type: "live_comment",
            senderId: v.from?.id,
            senderUsername: v.from?.username,
            text: v.text,
          });
        } else if (field === "messaging_postbacks") {
          await handleWebhookEvent(ws._id, {
            type: "postback",
            senderId: v.sender?.id,
            payload: v.postback?.payload,
            text: v.postback?.title,
          });
        } else if (field === "messaging_referral") {
          await handleWebhookEvent(ws._id, {
            type: "ref_url",
            senderId: v.sender?.id,
            refCode: v.referral?.ref,
          });
        }
      }
    }
  }
});

// ── GET /api/instagram/settings ──────────────────────────────────────────────
exports.getSettings = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const workspace = await Workspace.findById(workspaceId).select("settings");
  res.json(workspace?.settings || {});
});

// ── POST /api/instagram/test/trigger ────────────────────────────────────────
// Body: { igUserId: "123", username: "testuser", triggerType: "post_comment", text: "DM me" }
exports.testTrigger = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const { igUserId, username, triggerType = "post_comment", text } = req.body;
  if (!igUserId) return res.status(400).json({ error: "igUserId is required" });

  const event = {
    type: triggerType,
    senderId: String(igUserId),
    senderUsername: username || null,
    senderName: username || null,
    text: text || null,
  };

  logger.info(
    `[Test] Triggering ${triggerType} for ${igUserId} in workspace ${workspaceId}`,
  );
  await handleWebhookEvent(workspaceId, event);
  res.json({
    success: true,
    message: `Triggered ${triggerType} for ${igUserId}`,
  });
});

// ── POST /api/instagram/webhook/resubscribe ──────────────────────────────────
// Re-subscribes the IG account to all webhook fields we handle. Call from UI
// if automations aren't firing.
exports.resubscribeWebhook = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const ws = await Workspace.findById(workspaceId).select(
    "+instagram.accessToken",
  );
  if (!ws || ws.instagram?.status !== "connected") {
    return res.status(400).json({
      success: false,
      message: "Connect your Instagram account first.",
    });
  }
  let token;
  try {
    token = decrypt(ws.instagram.accessToken);
  } catch {
    return res.status(400).json({
      success: false,
      message: "Stored token unreadable. Please reconnect Instagram.",
    });
  }
  try {
    await ig.subscribeWebhook(token);
    await Workspace.findByIdAndUpdate(workspaceId, {
      "instagram.webhookSubscribed": true,
      "instagram.webhookError": null,
      "settings.automationEnabled": true,
    });
    return res.json({
      success: true,
      message: "Webhook re-subscribed. Automations should fire now.",
    });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    await Workspace.findByIdAndUpdate(workspaceId, {
      "instagram.webhookSubscribed": false,
      "instagram.webhookError": msg,
    });
    return res.status(502).json({ success: false, message: msg });
  }
});

// ── GET /api/instagram/diagnose ──────────────────────────────────────────────
// One-call health check for the "why isn't my automation working?" moment.
exports.diagnose = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const ws = await Workspace.findById(workspaceId).select(
    "instagram settings keywordTriggers dmKeywordTriggers conversationStarters fallbackReply dmMessages storyReplyTrigger storyMentionTrigger shareToStoryTrigger refUrlTriggers liveCommentTriggers businessHours",
  );
  if (!ws) return res.status(404).json({ error: "Workspace not found" });

  // accessToken has { select: false } on the schema; fetch it separately to
  // avoid Mongoose "path collision" when combining whole-subdoc + subpath selects.
  let tokenDoc = null;
  if (ws.instagram?.status === "connected") {
    tokenDoc = await Workspace.findById(workspaceId).select(
      "+instagram.accessToken",
    );
  }
  const encryptedToken = tokenDoc?.instagram?.accessToken || null;

  // Ask Meta what this account is ACTUALLY subscribed to — this is what
  // actually determines whether events will be delivered.
  let metaSubs = null;
  let metaSubsError = null;
  if (ws.instagram?.status === "connected" && encryptedToken) {
    try {
      const token = decrypt(encryptedToken);
      metaSubs = await ig.getSubscribedApps(token);
    } catch (e) {
      metaSubsError = e.response?.data?.error?.message || e.message;
    }
  }
  const subscribedFields =
    metaSubs && metaSubs.length ? metaSubs[0].subscribed_fields || [] : [];
  const hasMetaSub =
    Array.isArray(subscribedFields) && subscribedFields.length > 0;

  const checks = [];
  const push = (ok, label, hint) =>
    checks.push({ ok: !!ok, label, hint: ok ? null : hint });

  push(
    ws.instagram?.status === "connected",
    "Instagram connected",
    "Connect your Instagram Business account from the dashboard.",
  );
  push(
    !!ws.settings?.automationEnabled,
    "Automations enabled",
    "Turn on the 'Automations enabled' master switch.",
  );
  push(
    hasMetaSub,
    "App subscribed to this IG account (verified with Meta)",
    metaSubsError ||
      "Meta reports this account is NOT subscribed to any fields. In Meta App Dashboard, add the Webhooks product, set the callback URL to https://velox-whatbot-backend.onrender.com/api/instagram/webhook, then click 'Re-subscribe webhook' here.",
  );
  push(
    !!ws.instagram?.lastWebhookAt,
    "Meta has delivered at least one event",
    "No webhook has ever reached this server. Either the app isn't in Live mode (Dev mode only delivers events for app admins/testers), or the callback URL in Meta App Dashboard is wrong. Send a DM or comment from a test account added as an Instagram Tester.",
  );
  push(
    !ws.instagram?.tokenExpiresAt ||
      new Date(ws.instagram.tokenExpiresAt) > new Date(),
    "Access token valid",
    "Token expired. Reconnect Instagram.",
  );

  const anyTrigger =
    (ws.keywordTriggers || []).some((t) => t.enabled) ||
    (ws.dmKeywordTriggers || []).some((t) => t.enabled) ||
    ws.dmMessages?.enabled ||
    ws.storyReplyTrigger?.enabled ||
    ws.storyMentionTrigger?.enabled ||
    ws.shareToStoryTrigger?.enabled ||
    (ws.refUrlTriggers || []).some((t) => t.enabled) ||
    (ws.liveCommentTriggers || []).some((t) => t.enabled) ||
    ws.conversationStarters?.enabled ||
    ws.fallbackReply?.enabled;
  push(
    anyTrigger,
    "At least one trigger enabled",
    "Enable a trigger on the Automation page (e.g. a keyword or welcome DM).",
  );

  const allOk = checks.every((c) => c.ok);
  res.json({
    ok: allOk,
    checks,
    instagram: {
      username: ws.instagram?.username || null,
      webhookSubscribed: ws.instagram?.webhookSubscribed !== false,
      webhookError: ws.instagram?.webhookError || null,
      tokenExpiresAt: ws.instagram?.tokenExpiresAt || null,
      lastWebhookAt: ws.instagram?.lastWebhookAt || null,
      lastWebhookType: ws.instagram?.lastWebhookType || null,
      subscribedFields,
      metaSubsError,
    },
  });
});

// ── PUT /api/instagram/settings ──────────────────────────────────────────────
exports.updateSettings = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const allowed = [
    "automationEnabled",
    "minDelayMinutes",
    "maxDelayMinutes",
    "activeHourStart",
    "activeHourEnd",
    "quietSunday",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[`settings.${key}`] = req.body[key];
  }
  await Workspace.findByIdAndUpdate(workspaceId, updates);
  res.json({ success: true });
});
