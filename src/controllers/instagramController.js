/**
 * Botlify — Instagram Controller
 * Uses Instagram API with Instagram Login (not Facebook Login)
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const Workspace = require("../models/Workspace");
const ig = require("../services/instagram");
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
// If a hosted provider is configured (BOTLIFY_IG_PROVIDER_API_KEY) we return
// its hosted-auth URL so the customer skips Meta App Review entirely. Otherwise
// fall back to direct Instagram Business Login.
exports.getOAuthUrl = asyncHandler(async (req, res) => {
  // Hosted provider takes priority when configured.
  const botlifyIgEarly = require("../services/instagram/botlifyIgService");
  if (botlifyIgEarly.isConfigured()) {
    const workspaceId = req.headers["x-workspace-id"];
    const state = Buffer.from(
      JSON.stringify({ workspaceId, userId: req.user._id, ts: Date.now() }),
    ).toString("base64");
    const base =
      process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    const callbackUrl = `${base}/api/instagram/connect/callback-botlify`;
    try {
      const { url } = await botlifyIgEarly.createHostedAuthLink({
        state,
        callbackUrl,
      });
      return res.json({ url });
    } catch (err) {
      logger.error(
        "[IG connect] hosted provider failed, falling back to Meta",
        {
          err: err.response?.data || err.message,
        },
      );
      // fall through to Meta OAuth below
    }
  }

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
      "instagram.igBusinessAccountId": igInfo.id
        ? encrypt(String(igInfo.id))
        : undefined,
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
  const ws = await Workspace.findById(workspaceId).select(
    "+instagram.botlifyAccountId instagram.connectionType",
  );
  // Best-effort: tell the hosted provider to drop the account too.
  if (
    ws?.instagram?.connectionType === "botlify_oauth" &&
    ws.instagram.botlifyAccountId
  ) {
    try {
      const botlifyIgSvc = require("../services/instagram/botlifyIgService");
      const acc = decrypt(ws.instagram.botlifyAccountId);
      await botlifyIgSvc.disconnectAccount(acc);
    } catch (e) {
      logger.warn("[IG disconnect] provider cleanup failed", {
        err: e.message,
      });
    }
  }
  await Workspace.findByIdAndUpdate(workspaceId, {
    $unset: {
      "instagram.igUserId": 1,
      "instagram.accessToken": 1,
      "instagram.pageId": 1,
      "instagram.sessionCookie": 1,
      "instagram.botlifyAccountId": 1,
    },
    "instagram.status": "disconnected",
  });
  res.json({ success: true });
});

// ── POST /api/instagram/deauthorize ──────────────────────────────────────────
// Meta calls this when a user removes the app from their IG account.
// We parse the signed_request, find the workspace by encrypted igUserId, and
// wipe the stored Instagram credentials. Respond 200 fast.
const parseSignedRequest = (signedRequest, appSecret) => {
  if (!signedRequest || !appSecret) return null;
  const [sigB64, payloadB64] = signedRequest.split(".");
  if (!sigB64 || !payloadB64) return null;
  const b64urlToBuf = (s) =>
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(payloadB64)
    .digest();
  const given = b64urlToBuf(sigB64);
  if (
    expected.length !== given.length ||
    !crypto.timingSafeEqual(expected, given)
  )
    return null;
  try {
    return JSON.parse(b64urlToBuf(payloadB64).toString("utf8"));
  } catch {
    return null;
  }
};

exports.deauthorize = asyncHandler(async (req, res) => {
  const signed = req.body?.signed_request;
  const payload = parseSignedRequest(signed, IG_APP_SECRET);
  if (!payload?.user_id) {
    logger.warn("[IG deauthorize] invalid signed_request");
    return res.sendStatus(200);
  }
  const igUserId = String(payload.user_id);
  // Find workspace by matching the encrypted igUserId
  const all = await Workspace.find({
    "instagram.status": "connected",
  }).select("+instagram.igUserId");
  for (const ws of all) {
    try {
      if (decrypt(ws.instagram.igUserId) === igUserId) {
        await Workspace.findByIdAndUpdate(ws._id, {
          $unset: {
            "instagram.igUserId": 1,
            "instagram.accessToken": 1,
            "instagram.pageId": 1,
            "instagram.sessionCookie": 1,
          },
          "instagram.status": "disconnected",
          "instagram.webhookSubscribed": false,
        });
        logger.info(`[IG deauthorize] cleared workspace ${ws._id}`);
      }
    } catch {}
  }
  res.sendStatus(200);
});

// ── POST /api/instagram/data-deletion ────────────────────────────────────────
// Meta requires a public data-deletion endpoint. Users can request full
// deletion of their data. We wipe the workspace and return a status URL +
// confirmation_code as Meta expects.
exports.dataDeletion = asyncHandler(async (req, res) => {
  const signed = req.body?.signed_request;
  const payload = parseSignedRequest(signed, IG_APP_SECRET);
  if (!payload?.user_id) {
    return res.status(400).json({ error: "Invalid signed_request" });
  }
  const igUserId = String(payload.user_id);
  const code = crypto.randomBytes(8).toString("hex");
  // Best-effort wipe of any workspace connected to this IG user
  const all = await Workspace.find({
    "instagram.status": "connected",
  }).select("+instagram.igUserId");
  for (const ws of all) {
    try {
      if (decrypt(ws.instagram.igUserId) === igUserId) {
        await Workspace.findByIdAndUpdate(ws._id, {
          $unset: {
            "instagram.igUserId": 1,
            "instagram.accessToken": 1,
            "instagram.pageId": 1,
            "instagram.sessionCookie": 1,
            "instagram.username": 1,
            "instagram.displayName": 1,
            "instagram.profilePicture": 1,
          },
          "instagram.status": "disconnected",
          "instagram.webhookSubscribed": false,
        });
        logger.info(
          `[IG data-deletion] wiped workspace ${ws._id} code=${code}`,
        );
      }
    } catch {}
  }
  const base =
    process.env.API_PUBLIC_URL || "https://velox-whatbot-backend.onrender.com";
  res.json({
    url: `${base}/api/instagram/data-deletion/status?code=${code}`,
    confirmation_code: code,
  });
});

// Public status page Meta links users to after a deletion request.
exports.dataDeletionStatus = (req, res) => {
  const code = String(req.query.code || "");
  res.type("html").send(
    `<!doctype html><html><head><title>Data Deletion - Botlify</title></head>
<body style="font-family:system-ui;max-width:640px;margin:60px auto;padding:20px">
<h1>Botlify Data Deletion</h1>
<p>Your Instagram data has been removed from Botlify.</p>
<p>Confirmation code: <code>${code.replace(/[^a-f0-9]/gi, "")}</code></p>
<p>If you have further questions contact support@botlify.app.</p>
</body></html>`,
  );
};

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

  // Verify Meta signature using the raw Buffer.
  // We always 200 to Meta even on signature mismatch — returning 4xx puts our
  // endpoint into Meta's bad list. Just log and drop the event.
  const sig = req.headers["x-hub-signature-256"];
  let signatureValid = true;
  if (sig && IG_APP_SECRET) {
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", IG_APP_SECRET).update(rawBody).digest("hex");
    if (sig !== expected) {
      logger.warn("Instagram webhook signature mismatch — dropping");
      signatureValid = false;
    }
  }

  res.sendStatus(200); // respond fast to Meta no matter what
  if (!signatureValid) return;

  // Parse the raw Buffer into a JS object
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    logger.warn("Instagram webhook: malformed JSON body");
    return;
  }

  if (body.object !== "instagram") return;

  // Idempotency: dedupe by message id (mid) using in-memory LRU cache.
  // Meta retries on 5xx; without dedupe the same auto-reply fires twice.
  const seen = (exports._seenWebhookIds = exports._seenWebhookIds || new Map());
  const isDup = (id) => {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.set(id, Date.now());
    if (seen.size > 5000) {
      // evict oldest 1000
      const keys = Array.from(seen.keys()).slice(0, 1000);
      keys.forEach((k) => seen.delete(k));
    }
    return false;
  };

  for (const entry of body.entry || []) {
    const entryIgUserId = String(entry.id);
    const entryTypes = [];
    if (entry.messaging?.length) entryTypes.push("messaging");
    if (entry.changes?.length)
      entryTypes.push(...entry.changes.map((c) => c.field).filter(Boolean));

    const workspaces = await Workspace.find({
      "instagram.status": "connected",
    }).select(
      "+instagram.igUserId +instagram.igBusinessAccountId +instagram.accessToken",
    );

    logger.info(
      `[IG webhook] entry.id=${entryIgUserId} types=${entryTypes.join(",") || "none"} connectedWorkspaces=${workspaces.length}`,
    );

    let matched = false;
    for (const ws of workspaces) {
      let wsIgId;
      let wsIgBaId;
      try {
        wsIgId = decrypt(ws.instagram.igUserId);
      } catch (err) {
        logger.warn(
          `[IG webhook] decrypt igUserId failed for ws=${ws._id}: ${err.message}`,
        );
        continue;
      }
      if (ws.instagram.igBusinessAccountId) {
        try {
          wsIgBaId = decrypt(ws.instagram.igBusinessAccountId);
        } catch {}
      }

      // Backfill: if no IGBA stored, fetch /me?fields=id once and persist it
      // so future webhooks match without a reconnect.
      if (!wsIgBaId && ws.instagram.accessToken) {
        try {
          const token = decrypt(ws.instagram.accessToken);
          const ig = require("../services/instagram/metaService");
          const info = await ig.getIGAccountInfo(token);
          if (info?.id) {
            wsIgBaId = String(info.id);
            await Workspace.updateOne(
              { _id: ws._id },
              { $set: { "instagram.igBusinessAccountId": encrypt(wsIgBaId) } },
            );
            logger.info(
              `[IG webhook] backfilled igBusinessAccountId=${wsIgBaId} for ws=${ws._id}`,
            );
          }
        } catch (err) {
          logger.warn(
            `[IG webhook] backfill /me failed ws=${ws._id}: ${err.message}`,
          );
        }
      }

      if (wsIgId !== entryIgUserId && wsIgBaId !== entryIgUserId) {
        logger.info(
          `[IG webhook] ws=${ws._id} igUserId=${wsIgId} igBaId=${wsIgBaId || "n/a"} != entry=${entryIgUserId}`,
        );
        continue;
      }
      matched = true;
      logger.info(
        `[IG webhook] MATCH ws=${ws._id} via ${wsIgBaId === entryIgUserId ? "igBaId" : "igUserId"}`,
      );

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
        if (isDup(msg.message?.mid || msg.postback?.mid)) continue;

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
        // Voice note support (G7): if message has an audio attachment and no
        // text, download & transcribe via Whisper before passing to the
        // automation engine so keyword matching / AI replies work on voice.
        let messageText = message.text;
        const audioAttachment = attachments.find(
          (a) => a.type === "audio" && a.payload?.url,
        );
        if (!messageText && audioAttachment) {
          try {
            const { transcribeAudio } = require("../services/ai/openaiService");
            const out = await transcribeAudio({
              url: audioAttachment.payload.url,
            });
            if (out?.text) messageText = out.text;
          } catch (err) {
            console.warn("[IG voice] transcribe failed:", err.message);
          }
        }

        await handleWebhookEvent(ws._id, {
          type: "direct_message",
          senderId,
          senderUsername: null,
          senderName: null,
          text: messageText,
        });
      }

      // ── Change events (comments, mentions, live_comments) ────────────────────
      for (const change of entry.changes || []) {
        const field = change.field;
        const v = change.value || {};
        if (isDup(v.id || v.comment_id)) continue;

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
    if (!matched) {
      logger.warn(
        `[IG webhook] NO WORKSPACE MATCHED entry.id=${entryIgUserId} — drop`,
      );
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
// Body: { triggerType: "direct_message"|"post_comment"|...,
//         text: "hi", username?: "demo_user" }
// Runs the automation engine end-to-end against the real workspace config so
// a conversation + inbound + outbound message appear in the Inbox. Great for
// product demos/screencasts when a real IG→IG tester loop isn't available.
exports.testTrigger = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const {
    triggerType = "direct_message",
    text = "hi",
    username = "demo_user",
    igUserId,
  } = req.body;

  // Synthesize a fake-but-stable IG sender id per workspace so repeated
  // simulate clicks reuse the same demo contact/conversation.
  const fakeSenderId =
    igUserId ||
    `demo_${crypto.createHash("md5").update(String(workspaceId)).digest("hex").slice(0, 12)}`;

  const event = {
    type: triggerType,
    senderId: fakeSenderId,
    senderUsername: username,
    senderName: username,
    text,
  };

  logger.info(`[Simulate] ${triggerType} text="${text}" ws=${workspaceId}`);
  await handleWebhookEvent(workspaceId, event);
  res.json({
    success: true,
    message:
      "Simulated event dispatched. Open the Inbox tab to see the conversation.",
    event,
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

// ── GET /api/instagram/debug/identity ────────────────────────────────────────
// Returns the decrypted IG numeric user ID + workspace ID so you can build
// a Postman webhook payload that exactly mimics what Meta would POST.
exports.debugIdentity = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const ws = await Workspace.findById(workspaceId).select(
    "+instagram.igUserId +instagram.pageId instagram.username",
  );
  if (!ws?.instagram?.igUserId) {
    return res
      .status(400)
      .json({ success: false, message: "Instagram not connected" });
  }
  let igUserId, pageId;
  try {
    igUserId = decrypt(ws.instagram.igUserId);
  } catch (e) {
    return res
      .status(500)
      .json({ success: false, message: "Could not decrypt IG user ID" });
  }
  try {
    pageId = ws.instagram.pageId ? decrypt(ws.instagram.pageId) : null;
  } catch {
    pageId = null;
  }
  const webhookUrl = `${req.protocol}://${req.get("host")}/api/instagram/webhook`;
  res.json({
    success: true,
    workspaceId: String(ws._id),
    username: ws.instagram.username,
    igUserId,
    pageId,
    webhookUrl,
    examplePayload: {
      object: "instagram",
      entry: [
        {
          id: igUserId,
          time: Math.floor(Date.now() / 1000),
          messaging: [
            {
              sender: { id: "REPLACE_WITH_TESTER_IG_USER_ID" },
              recipient: { id: igUserId },
              timestamp: Date.now(),
              message: {
                mid: `m_${Date.now()}`,
                text: "price",
              },
            },
          ],
        },
      ],
    },
  });
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

  // VIP comment prioritizer (B4) — accept the full sub-object on this same endpoint.
  if (req.body.vipComments !== undefined) {
    const v = req.body.vipComments || {};
    updates["vipComments.enabled"] = !!v.enabled;
    if (Array.isArray(v.usernames)) {
      updates["vipComments.usernames"] = v.usernames
        .map((u) => String(u).toLowerCase().replace(/^@/, "").trim())
        .filter(Boolean)
        .slice(0, 200);
    }
    if (typeof v.autoDmTemplate === "string") {
      updates["vipComments.autoDmTemplate"] = v.autoDmTemplate.slice(0, 500);
    }
  }

  await Workspace.findByIdAndUpdate(workspaceId, updates);
  res.json({ success: true });
});

// ─── Hosted IG provider (Botlify Cloud — white-labeled) ─────────────────────
const botlifyIg = require("../services/instagram/botlifyIgService");

// GET /api/instagram/connect/botlify-url
// Returns a one-time hosted-auth URL the user is redirected to. Provider walks
// them through Instagram login + permissions, then bounces them to our
// callback below. Customers never see the upstream provider name.
exports.getBotlifyOAuthUrl = asyncHandler(async (req, res) => {
  if (!botlifyIg.isConfigured()) {
    return res.status(503).json({
      message: "Instagram provider not yet configured on this server.",
    });
  }
  const workspaceId = req.headers["x-workspace-id"];
  const state = Buffer.from(
    JSON.stringify({ workspaceId, userId: req.user._id, ts: Date.now() }),
  ).toString("base64");

  const base =
    process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const callbackUrl = `${base}/api/instagram/connect/callback-botlify`;

  try {
    const { url } = await botlifyIg.createHostedAuthLink({
      state,
      callbackUrl,
    });
    res.json({ url });
  } catch (err) {
    logger.error("[BotlifyIG] hosted auth link failed", {
      err: err.response?.data || err.message,
    });
    res.status(502).json({
      message: "Could not start Instagram connect. Please try again shortly.",
    });
  }
});

// GET /api/instagram/connect/callback-botlify
// Provider redirects user back here with ?accountId=xxx (or ?code=xxx) + state.
exports.botlifyOAuthCallback = asyncHandler(async (req, res) => {
  const { code, accountId, state, error, error_description } = req.query;
  if (error) {
    logger.warn("[BotlifyIG] connect cancelled", { error, error_description });
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
    const { accountId: acc, info } = await botlifyIg.exchangeCallback({
      code,
      accountId,
    });

    // Subscribe the IG account to our webhook on the provider side.
    let webhookSubscribed = false;
    let webhookError = null;
    try {
      await botlifyIg.subscribeWebhook(acc);
      webhookSubscribed = true;
    } catch (e) {
      webhookError = e.response?.data?.error || e.message;
      logger.warn("[BotlifyIG] webhook subscribe failed", {
        err: webhookError,
      });
    }

    // We store the wrapped token "zer:<accountId>" — the dispatcher uses the
    // prefix to route every subsequent call to botlifyIgService.
    const wrappedToken = botlifyIg.wrapAccountId(acc);

    await Workspace.findByIdAndUpdate(workspaceId, {
      "instagram.status": "connected",
      "instagram.connectionType": "botlify_oauth",
      "instagram.igUserId": encrypt(String(info.user_id || acc)),
      "instagram.accessToken": encrypt(wrappedToken),
      "instagram.botlifyAccountId": encrypt(acc),
      "instagram.username": info.username,
      "instagram.displayName": info.name || info.username,
      "instagram.profilePicture": info.profile_picture_url,
      "instagram.followersCount": info.followers_count,
      "instagram.connectedAt": new Date(),
      "instagram.tokenExpiresAt": null, // hosted provider manages renewal
      "instagram.webhookSubscribed": webhookSubscribed,
      "instagram.webhookError": webhookError,
      "settings.automationEnabled": true,
      onboardingCompleted: true,
    });

    return res.redirect(
      `${process.env.CLIENT_URL}/dashboard?connected=true${webhookSubscribed ? "" : "&webhook=failed"}`,
    );
  } catch (err) {
    logger.error("[BotlifyIG] callback failed", {
      err: err.response?.data || err.message,
    });
    return res.redirect(
      `${process.env.CLIENT_URL}/dashboard?error=oauth_failed`,
    );
  }
});

// POST /api/instagram/webhook/botlify
// The hosted provider POSTs IG events here. Payload shape differs from Meta's
// raw webhook so we translate to our internal `handleWebhookEvent` format.
// Signature: X-Botlify-Signature: sha256=<hex(hmac(secret, rawBody))>
exports.receiveBotlifyWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.body; // Buffer (express.raw applied in server.js)
  const secret = process.env.BOTLIFY_IG_PROVIDER_WEBHOOK_SECRET;
  const sig =
    req.headers["x-botlify-signature"] || req.headers["x-zernio-signature"];

  if (secret && sig) {
    try {
      const expected =
        "sha256=" +
        crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      if (sig !== expected) {
        logger.warn("[BotlifyIG webhook] signature mismatch — dropping");
        return res.sendStatus(200);
      }
    } catch {
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200); // ack fast

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    logger.warn("[BotlifyIG webhook] malformed JSON");
    return;
  }

  // Normalize: provider may send a single event or an array.
  const events = Array.isArray(body) ? body : body.events || [body];

  for (const evt of events) {
    const accountId = evt.accountId || evt.account_id;
    if (!accountId) continue;

    // Find the workspace by encrypted botlifyAccountId.
    const all = await Workspace.find({
      "instagram.status": "connected",
      "instagram.connectionType": "botlify_oauth",
    }).select("+instagram.botlifyAccountId");

    let target = null;
    for (const ws of all) {
      try {
        if (
          ws.instagram?.botlifyAccountId &&
          decrypt(ws.instagram.botlifyAccountId) === accountId
        ) {
          target = ws;
          break;
        }
      } catch {}
    }
    if (!target) continue;

    Workspace.updateOne(
      { _id: target._id },
      {
        $set: {
          "instagram.lastWebhookAt": new Date(),
          "instagram.lastWebhookType": evt.type || "unknown",
        },
      },
    ).catch(() => {});

    // Account-level events (no senderId required)
    if (evt.type === "account.disconnected") {
      logger.warn(
        `[BotlifyIG webhook] account disconnected for workspace ${target._id}`,
      );
      await Workspace.updateOne(
        { _id: target._id },
        {
          $set: { "instagram.status": "disconnected" },
          $unset: {
            "instagram.accessToken": 1,
            "instagram.botlifyAccountId": 1,
          },
        },
      ).catch(() => {});
      continue;
    }
    if (
      evt.type === "account.connected" ||
      evt.type === "account.ads.initial_sync_completed"
    ) {
      logger.info(`[BotlifyIG webhook] ${evt.type} acknowledged`);
      continue;
    }
    // Outbound echo events — we don't act on these, just ack.
    if (
      evt.type === "message.sent" ||
      evt.type === "message.delivered" ||
      evt.type === "message.read" ||
      evt.type === "message.failed" ||
      evt.type === "message.edited" ||
      evt.type === "message.deleted" ||
      evt.type?.startsWith("post.") ||
      evt.type?.startsWith("review.")
    ) {
      continue;
    }

    const senderId =
      evt.sender?.id || evt.from?.id || evt.senderId || evt.userId || null;
    if (!senderId) continue;

    // Translate provider event → automation engine event shape.
    switch (evt.type) {
      case "message.received":
      case "message":
      case "dm":
        await handleWebhookEvent(target._id, {
          type: "direct_message",
          senderId,
          senderUsername: evt.sender?.username || null,
          senderName: evt.sender?.name || null,
          text: evt.message?.text || evt.text || "",
        });
        break;
      case "comment.received":
      case "comment":
        await handleWebhookEvent(target._id, {
          type: "post_comment",
          senderId,
          senderUsername: evt.sender?.username || null,
          text: evt.comment?.text || evt.text || "",
          postId: evt.post?.id || evt.postId || null,
        });
        break;
      case "story.mention":
      case "story_mention":
        await handleWebhookEvent(target._id, {
          type: "story_mention",
          senderId,
          senderUsername: evt.sender?.username || null,
        });
        break;
      case "story.reply":
      case "story_reply":
        await handleWebhookEvent(target._id, {
          type: "story_reply",
          senderId,
          text: evt.message?.text || evt.text || "",
          storyId: evt.storyId || null,
        });
        break;
      default:
        logger.info(`[BotlifyIG webhook] unhandled type: ${evt.type}`);
    }
  }
});
