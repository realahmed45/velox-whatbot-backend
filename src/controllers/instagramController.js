/**
 * Flowgram — Instagram Controller
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

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const REDIRECT_URI = process.env.IG_OAUTH_REDIRECT_URI;
const WEBHOOK_VERIFY_TOKEN =
  process.env.IG_WEBHOOK_VERIFY_TOKEN || "flowgram_webhook_2026";

// ── GET /api/instagram/connect/oauth-url ─────────────────────────────────────
exports.getOAuthUrl = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const state = Buffer.from(
    JSON.stringify({ workspaceId, userId: req.user._id }),
  ).toString("base64");
  const scopes = [
    "instagram_basic",
    "instagram_manage_messages",
    "instagram_manage_comments",
    "pages_show_list",
    "pages_read_engagement",
  ].join(",");

  const url = `https://www.facebook.com/dialog/oauth?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scopes}&state=${state}&response_type=code`;
  res.json({ url });
});

// ── GET /api/instagram/connect/callback ──────────────────────────────────────
exports.oauthCallback = asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(
      `${process.env.CLIENT_URL}/onboarding/connect?error=cancelled`,
    );
  }

  let workspaceId;
  try {
    ({ workspaceId } = JSON.parse(Buffer.from(state, "base64").toString()));
  } catch {
    return res.redirect(
      `${process.env.CLIENT_URL}/onboarding/connect?error=invalid_state`,
    );
  }

  // Exchange code → short-lived token
  const tokenData = await ig.exchangeCodeForToken(code, REDIRECT_URI);
  const longTokenData = await ig.getLongLivedToken(tokenData.access_token);
  const userToken = longTokenData.access_token;

  // Get pages the user manages
  const pages = await ig.getUserPages(userToken);
  if (!pages.length) {
    return res.redirect(
      `${process.env.CLIENT_URL}/onboarding/connect?error=no_pages`,
    );
  }

  // Use the first page that has an IG business account
  const page = pages.find((p) => p.instagram_business_account) || pages[0];
  const pageToken = page.access_token;
  const igAcctId =
    page.instagram_business_account?.id ||
    (await ig.getIGAccountId(page.id, pageToken));

  if (!igAcctId) {
    return res.redirect(
      `${process.env.CLIENT_URL}/onboarding/connect?error=no_ig_account`,
    );
  }

  const igInfo = await ig.getIGAccountInfo(igAcctId, pageToken);

  // Subscribe webhook
  try {
    await ig.subscribeWebhook(page.id, pageToken);
  } catch (e) {
    logger.warn("Webhook subscribe failed (will retry)", { err: e.message });
  }

  // Save to workspace (encrypted)
  await Workspace.findByIdAndUpdate(workspaceId, {
    "instagram.status": "connected",
    "instagram.connectionType": "meta_oauth",
    "instagram.igUserId": encrypt(igAcctId),
    "instagram.accessToken": encrypt(pageToken),
    "instagram.pageId": encrypt(page.id),
    "instagram.username": igInfo.username,
    "instagram.displayName": igInfo.name,
    "instagram.profilePicture": igInfo.profile_picture_url,
    "instagram.followersCount": igInfo.followers_count,
    "instagram.connectedAt": new Date(),
    "instagram.tokenExpiresAt": new Date(Date.now() + 55 * 24 * 3600000),
    onboardingCompleted: true,
  });

  res.redirect(`${process.env.CLIENT_URL}/dashboard?connected=1`);
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
  // Verify signature
  const sig = req.headers["x-hub-signature-256"];
  if (sig && APP_SECRET) {
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", APP_SECRET)
        .update(req.rawBody || JSON.stringify(req.body))
        .digest("hex");
    if (sig !== expected) {
      logger.warn("Instagram webhook signature mismatch");
      return res.sendStatus(403);
    }
  }

  res.sendStatus(200); // respond fast

  const body = req.body;
  if (body.object !== "instagram") return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;

    // Find workspace by pageId
    const workspaces = await Workspace.find({
      "instagram.status": "connected",
    }).select("+instagram.pageId +instagram.igUserId +instagram.accessToken");

    for (const ws of workspaces) {
      let wsPageId;
      try {
        wsPageId = decrypt(ws.instagram.pageId);
      } catch {
        continue;
      }
      if (wsPageId !== pageId) continue;

      // Process messaging events
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        if (!senderId || senderId === decrypt(ws.instagram.igUserId)) continue;

        const event = {
          type: "direct_message",
          senderId,
          senderUsername: null,
          senderName: null,
          text: msg.message?.text,
        };

        await handleWebhookEvent(ws._id, event);
      }

      // Process feed events (comments)
      for (const change of entry.changes || []) {
        if (change.field === "comments" && change.value) {
          const event = {
            type: "post_comment",
            senderId: change.value.from?.id,
            text: change.value.text,
            postId: change.value.media?.id,
          };
          await handleWebhookEvent(ws._id, event);
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
