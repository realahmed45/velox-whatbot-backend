/**
 * Botlify — Multi-channel Controller (WhatsApp / TikTok via Zernio)
 *
 * Mirrors the Instagram hosted-auth flow (see instagramController) but stores
 * connections in the workspace `channels` array instead of the legacy
 * `instagram` subdoc. Same Zernio account, same per-workspace profile, same
 * webhook endpoint — the webhook receiver routes events by account hash.
 */
const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const zernioSocial = require("../services/channels/zernioSocialService");
const { encrypt, decrypt } = require("../utils/encryption");
const { hashToken } = require("../utils/crypto");
const logger = require("../utils/logger");

const CLIENT_URL = () => process.env.CLIENT_URL || "https://botlify.site";

const normalizePlatform = (p) => String(p || "").toLowerCase();

/**
 * Resolve (or lazily create) the workspace's Zernio profile — the SAME one the
 * Instagram flow uses (instagram.botlifyProfileId), so every platform for a
 * workspace lives under one tenant profile.
 */
const resolveWorkspaceProfileId = async (workspaceId) => {
  const wsDoc = await Workspace.findById(workspaceId).select(
    "+instagram.botlifyProfileId name",
  );
  let profileId = wsDoc?.instagram?.botlifyProfileId
    ? decrypt(wsDoc.instagram.botlifyProfileId)
    : null;
  if (!profileId) {
    profileId = await zernioSocial.createProfile({
      name: `ws_${workspaceId}`,
      description: wsDoc?.name || "Botlify workspace",
    });
    await Workspace.findByIdAndUpdate(workspaceId, {
      "instagram.botlifyProfileId": encrypt(String(profileId)),
    });
    logger.info("[Channels] created Zernio profile for workspace", {
      workspaceId,
      profileId,
    });
  }
  return profileId;
};

// ── GET /api/channels/status ─────────────────────────────────────────────────
// One call for the dashboard: connection state of every messaging channel.
exports.getStatus = asyncHandler(async (req, res) => {
  const ws = req.workspace; // set by requireWorkspace
  const out = {
    instagram: {
      status: ws.instagram?.status || "disconnected",
      username: ws.instagram?.username || null,
    },
  };
  for (const platform of zernioSocial.PLATFORMS) {
    const entry = (ws.channels || []).find((c) => c.platform === platform);
    out[platform] = {
      status: entry?.status || "disconnected",
      username: entry?.username || null,
      displayName: entry?.displayName || null,
      profilePicture: entry?.profilePicture || null,
      phoneNumber: entry?.phoneNumber || null,
      connectedAt: entry?.connectedAt || null,
      lastWebhookAt: entry?.lastWebhookAt || null,
      webhookError: entry?.webhookError || null,
    };
  }
  res.json(out);
});

// ── GET /api/channels/:platform/connect ──────────────────────────────────────
// Returns the hosted-auth URL the browser is redirected to (owner only).
exports.getConnectUrl = asyncHandler(async (req, res) => {
  const platform = normalizePlatform(req.params.platform);
  if (!zernioSocial.isSupportedPlatform(platform)) {
    // TikTok is the common case here: it has no DM API, so the concierge
    // cannot work there. Say that plainly instead of a generic rejection.
    const message =
      platform === "tiktok"
        ? "TikTok does not offer a messaging API, so the AI concierge cannot answer TikTok DMs. Connect WhatsApp or Instagram instead."
        : `Unsupported channel: ${platform}`;
    return res.status(400).json({ message });
  }
  if (!zernioSocial.isConfigured()) {
    return res.status(503).json({
      message: "Messaging provider not yet configured on this server.",
    });
  }
  const workspaceId = req.workspace._id;

  // Per-workspace Zernio profile (tenant isolation) — same as the IG flow.
  let profileId = null;
  try {
    profileId = await resolveWorkspaceProfileId(workspaceId);
  } catch (err) {
    logger.warn("[Channels] profile setup failed, using default profile", {
      err: err.response?.data || err.message,
    });
    profileId = null; // fall back to shared default inside the service
  }

  const base =
    process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  // Embed workspace id in the callback so it knows which workspace to attach.
  // Carry the caller's origin through the round trip so the callback can send
  // them back to the same place (wizard step vs Settings).
  const from = req.query.from === "onboarding" ? "onboarding" : "channels";
  const callbackUrl =
    `${base}/api/channels/${platform}/callback` +
    `?ws=${encodeURIComponent(workspaceId)}` +
    `&from=${from}`;

  try {
    // WhatsApp: let the caller pick the Embedded Signup mode.
    //   ?mode=business_app (default) — number lives on the WhatsApp Business
    //     app, which is the normal hotel front-desk setup
    //   ?mode=api — number is already on Cloud API with another provider
    const mode = String(req.query.mode || "").trim();
    const { url } = await zernioSocial.createHostedAuthLink({
      platform,
      profileId,
      callbackUrl,
      ...(mode === "api" || mode === "business_app"
        ? { onboarding: mode }
        : {}),
    });
    res.json({ url });
  } catch (err) {
    logger.error(`[Channels] ${platform} hosted auth link failed`, {
      err: err.response?.data || err.message,
    });
    res.status(502).json({
      message: "Could not start the connection. Please try again shortly.",
    });
  }
});

// ── GET /api/channels/:platform/callback ─────────────────────────────────────
// PUBLIC — Zernio redirects the browser here with ?accountId= (mirrors the IG
// callback). Attach the account to the workspace named in ?ws=.
exports.oauthCallback = asyncHandler(async (req, res) => {
  const platform = normalizePlatform(req.params.platform);
  const { ws, accountId, error, error_description, from } = req.query;
  // Return the user to wherever they started. Mid-onboarding that's the wizard
  // step they left; otherwise Settings > Channels. Without this a hotel
  // connecting WhatsApp during setup got dumped at /dashboard/channels and the
  // onboarding gate then bounced them to pricing — losing their progress.
  const ALLOWED_RETURNS = {
    onboarding: "/onboarding/hotel?step=messaging",
    channels: "/dashboard/channels",
  };
  const dash = `${CLIENT_URL()}${
    ALLOWED_RETURNS[String(from || "")] || ALLOWED_RETURNS.channels
  }`;

  if (!zernioSocial.isSupportedPlatform(platform)) {
    return res.redirect(302, `${dash}?error=unsupported_platform`);
  }

  // Headless Messenger: the provider returns raw OAuth data instead of a
  // finished account, so the user picks their Page in OUR UI. Hand the
  // short-lived token to the frontend and let it call the endpoints below.
  if (platform === "messenger" && req.query.tempToken) {
    const params = new URLSearchParams({
      pick: "facebook",
      tempToken: String(req.query.tempToken),
      ...(req.query.userProfile
        ? { userProfile: String(req.query.userProfile) }
        : {}),
    });
    return res.redirect(302, `${dash}?${params.toString()}`);
  }
  if (error) {
    logger.warn(`[Channels] ${platform} connect cancelled`, {
      error,
      error_description,
    });
    return res.redirect(302, `${dash}?error=cancelled`);
  }
  if (!ws) {
    logger.warn(`[Channels] ${platform} callback missing workspace id`, {
      query: req.query,
    });
    return res.redirect(302, `${dash}?error=invalid_state`);
  }

  try {
    const workspace = await Workspace.findById(ws).select(
      "+instagram.botlifyProfileId channels",
    );
    if (!workspace) {
      return res.redirect(302, `${dash}?error=invalid_state`);
    }

    // Resolve the just-connected account. Prefer the accountId Zernio put in
    // the redirect (source of truth — same fast path as the IG callback);
    // fall back to the newest account in this workspace's profile.
    let info = null;
    let acc = accountId ? String(accountId) : null;
    if (acc) {
      try {
        info = await zernioSocial.getAccountInfo(acc);
      } catch (err) {
        logger.warn(
          `[Channels] ${platform} direct account lookup failed, trying list`,
          { accountId: acc, err: err.response?.data || err.message },
        );
      }
    }
    if (!info) {
      let profileId = null;
      try {
        profileId = workspace.instagram?.botlifyProfileId
          ? decrypt(workspace.instagram.botlifyProfileId)
          : null;
      } catch {
        /* unscoped lookup below */
      }
      const accounts = await zernioSocial.listAccounts(platform, profileId);
      const match = acc
        ? accounts.find((a) => String(a.accountId) === acc)
        : accounts.sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
          )[0];
      if (match) {
        acc = String(match.accountId);
        info = match;
      }
    }
    if (!acc) {
      logger.warn(`[Channels] ${platform} callback: no account resolved`);
      return res.redirect(302, `${dash}?error=no_account`);
    }
    // The provider API can lag right after connect — save a minimal record now.
    if (!info) info = { accountId: acc, user_id: acc };

    // One provider account → one workspace (same guarantee as Instagram).
    // The unique partial index on channels.accountHash enforces it; pre-check
    // here so the user gets a clear message instead of a raw E11000.
    const accountHash = hashToken(String(acc));
    const conflict = await Workspace.findOne({
      "channels.accountHash": accountHash,
      _id: { $ne: workspace._id },
    }).select("_id");
    if (conflict) {
      logger.warn(
        `[Channels] ${platform} account already connected to another workspace`,
        { accountHash },
      );
      return res.redirect(302, `${dash}?error=already_connected`);
    }

    // Subscribe the provider webhook (same endpoint as Instagram — the
    // receiver routes by account hash).
    let webhookError = null;
    try {
      await zernioSocial.subscribeWebhook(acc);
    } catch (e) {
      webhookError = e.response?.data?.error || e.message;
    }

    // Upsert the platform entry in workspace.channels. accountId is encrypted
    // with the same AES helpers as instagram.botlifyAccountId; accountHash is
    // the same SHA-256 helper as igAccountHash (used for webhook routing).
    const fields = {
      status: "connected",
      accountId: encrypt(String(acc)),
      accountHash,
      username: info.username || null,
      displayName: info.name || info.username || null,
      profilePicture: info.profile_picture_url || null,
      phoneNumber: info.phone_number || null,
      connectedAt: new Date(),
      webhookError,
    };
    const hasEntry = (workspace.channels || []).some(
      (c) => c.platform === platform,
    );
    try {
      if (hasEntry) {
        await Workspace.updateOne(
          { _id: workspace._id, "channels.platform": platform },
          {
            $set: Object.fromEntries(
              Object.entries(fields).map(([k, v]) => [`channels.$.${k}`, v]),
            ),
          },
        );
      } else {
        await Workspace.updateOne(
          { _id: workspace._id },
          { $push: { channels: { platform, ...fields } } },
        );
      }
    } catch (e) {
      // Duplicate accountHash (raced past the pre-check) — clear message.
      if (e.code === 11000 || /E11000/.test(e.message || "")) {
        logger.warn(
          `[Channels] ${platform} duplicate account hash on save — already connected elsewhere`,
        );
        return res.redirect(302, `${dash}?error=already_connected`);
      }
      throw e;
    }

    logger.info(
      `[Channels] ${platform} connected ws=${workspace._id} account=${acc} webhook=${webhookError ? "failed" : "ok"}`,
    );
    return res.redirect(
      302,
      `${dash}?connected=${platform}${webhookError ? "&webhook=failed" : ""}`,
    );
  } catch (err) {
    logger.error(`[Channels] ${platform} callback failed`, {
      err: err.response?.data || err.message,
    });
    return res.redirect(302, `${dash}?error=connect_failed`);
  }
});

/**
 * Persist a connected channel account onto the workspace. Shared by the OAuth
 * callback and the Telegram pairing flow, which arrive at the same end state by
 * different routes.
 * @returns {Promise<{ok: boolean, reason?: string, webhookError?: string}>}
 */
async function saveChannelAccount({ workspace, platform, accountId, info = {} }) {
  const accountHash = hashToken(String(accountId));
  const conflict = await Workspace.findOne({
    "channels.accountHash": accountHash,
    _id: { $ne: workspace._id },
  }).select("_id");
  if (conflict) return { ok: false, reason: "already_connected" };

  let webhookError = null;
  try {
    await zernioSocial.subscribeWebhook(accountId);
  } catch (e) {
    webhookError = e.response?.data?.error || e.message;
  }

  const fields = {
    status: "connected",
    provider: "zernio",
    accountId: encrypt(String(accountId)),
    accountHash,
    username: info.username || null,
    displayName: info.name || info.title || info.username || null,
    profilePicture: info.profile_picture_url || null,
    phoneNumber: info.phone_number || null,
    connectedAt: new Date(),
    webhookError,
  };
  const hasEntry = (workspace.channels || []).some(
    (c) => c.platform === platform,
  );
  try {
    if (hasEntry) {
      await Workspace.updateOne(
        { _id: workspace._id, "channels.platform": platform },
        {
          $set: Object.fromEntries(
            Object.entries(fields).map(([k, v]) => [`channels.$.${k}`, v]),
          ),
        },
      );
    } else {
      await Workspace.updateOne(
        { _id: workspace._id },
        { $push: { channels: { platform, ...fields } } },
      );
    }
  } catch (e) {
    if (e.code === 11000 || /E11000/.test(e.message || "")) {
      return { ok: false, reason: "already_connected" };
    }
    throw e;
  }
  return { ok: true, webhookError };
}

// ── Telegram pairing ─────────────────────────────────────────────────────────
// Telegram bots can't be OAuth'd like a Meta app. The hotel adds our bot as an
// admin of their channel/group and sends it a short code; we poll for the link.

// @GET /api/channels/telegram/code — start pairing, returns the code + bot name
exports.telegramCode = asyncHandler(async (req, res) => {
  const profileId = await resolveWorkspaceProfileId(req.workspace._id);
  const result = await zernioSocial.createTelegramCode(profileId);
  if (!result.code) {
    res.status(502);
    throw new Error("Could not start Telegram pairing. Please try again.");
  }
  res.json({
    success: true,
    code: result.code,
    botUsername: result.botUsername,
    expiresAt: result.expiresAt,
    instructions: [
      result.botUsername
        ? `Add @${result.botUsername} to your Telegram group or channel as an admin.`
        : "Add our Telegram bot to your group or channel as an admin.",
      `Send this code to the bot: ${result.code}`,
      "Come back here — we'll detect it automatically.",
    ],
  });
});

// @GET /api/channels/telegram/status?code=... — poll pairing (client every ~3s)
exports.telegramStatus = asyncHandler(async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) {
    res.status(400);
    throw new Error("Pairing code required");
  }
  const result = await zernioSocial.checkTelegramCode(code);
  if (result.status !== "connected" || !result.accountId) {
    return res.json({ success: true, status: result.status });
  }
  const saved = await saveChannelAccount({
    workspace: req.workspace,
    platform: "telegram",
    accountId: result.accountId,
    info: { username: result.username, title: result.username },
  });
  if (!saved.ok) {
    return res.json({ success: false, status: "error", reason: saved.reason });
  }
  logger.info(
    `[Channels] telegram connected ws=${req.workspace._id} account=${result.accountId}`,
  );
  res.json({
    success: true,
    status: "connected",
    username: result.username,
    webhookError: saved.webhookError || null,
  });
});

// ── Facebook page picker (headless Messenger connect) ───────────────────────

// @GET /api/channels/messenger/pages?tempToken=...
// The Pages this user manages, so they choose one inside Botlify.
exports.listMessengerPages = asyncHandler(async (req, res) => {
  const tempToken = String(req.query.tempToken || "").trim();
  if (!tempToken) {
    res.status(400);
    throw new Error("Missing connection token — please start again.");
  }
  const profileId = await resolveWorkspaceProfileId(req.workspace._id);
  const pages = await zernioSocial.listFacebookPages({ profileId, tempToken });
  res.json({ success: true, pages });
});

// @POST /api/channels/messenger/pages — { pageId, tempToken, userProfile }
exports.selectMessengerPage = asyncHandler(async (req, res) => {
  const { pageId, tempToken, userProfile } = req.body || {};
  if (!pageId || !tempToken) {
    res.status(400);
    throw new Error("Pick a Page to connect.");
  }
  const profileId = await resolveWorkspaceProfileId(req.workspace._id);
  let parsedProfile = userProfile;
  if (typeof userProfile === "string") {
    try {
      parsedProfile = JSON.parse(userProfile);
    } catch {
      parsedProfile = undefined;
    }
  }
  const result = await zernioSocial.selectFacebookPage({
    profileId,
    pageId,
    tempToken,
    userProfile: parsedProfile,
  });
  if (!result.accountId) {
    res.status(502);
    throw new Error("Could not finish connecting that Page. Try again.");
  }
  const saved = await saveChannelAccount({
    workspace: req.workspace,
    platform: "messenger",
    accountId: result.accountId,
    info: { username: result.username, name: result.username },
  });
  if (!saved.ok) {
    res.status(409);
    throw new Error(
      saved.reason === "already_connected"
        ? "That Facebook Page is already connected to another account."
        : "Could not save the connection.",
    );
  }
  logger.info(
    `[Channels] messenger connected ws=${req.workspace._id} page=${pageId}`,
  );
  res.json({
    success: true,
    username: result.username,
    webhookError: saved.webhookError || null,
  });
});

// ── DELETE /api/channels/:platform ───────────────────────────────────────────
// Owner disconnects a channel: best-effort provider cleanup, then clear the
// entry (keep the row so the dashboard remembers the last username).
exports.disconnect = asyncHandler(async (req, res) => {
  const platform = normalizePlatform(req.params.platform);
  if (!zernioSocial.isSupportedPlatform(platform)) {
    // TikTok is the common case here: it has no DM API, so the concierge
    // cannot work there. Say that plainly instead of a generic rejection.
    const message =
      platform === "tiktok"
        ? "TikTok does not offer a messaging API, so the AI concierge cannot answer TikTok DMs. Connect WhatsApp or Instagram instead."
        : `Unsupported channel: ${platform}`;
    return res.status(400).json({ message });
  }
  const workspaceId = req.workspace._id;

  const ws = await Workspace.findById(workspaceId).select("+channels.accountId");
  const entry = (ws?.channels || []).find((c) => c.platform === platform);
  if (!entry) {
    return res.status(404).json({ message: `${platform} is not connected.` });
  }

  // Best-effort: tell the provider to drop the account too (same pattern as
  // botlifyIgService.disconnectAccount usage in the IG disconnect).
  if (entry.accountId) {
    try {
      const acc = decrypt(entry.accountId);
      if (acc) await zernioSocial.disconnectAccount(acc);
    } catch (e) {
      logger.warn(`[Channels] ${platform} provider cleanup failed`, {
        err: e.message,
      });
    }
  }

  await Workspace.updateOne(
    { _id: workspaceId, "channels.platform": platform },
    {
      $set: {
        "channels.$.status": "disconnected",
        "channels.$.accountId": null,
        "channels.$.accountHash": null,
        "channels.$.webhookError": null,
      },
    },
  );
  res.json({ success: true });
});
