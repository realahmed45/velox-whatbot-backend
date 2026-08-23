/**
 * Botlify — Multi-channel (WhatsApp / TikTok) Hosted Provider Service
 *
 * Platform-generic wrapper around the SAME upstream hosted provider (Zernio)
 * that powers Instagram (see ../instagram/botlifyIgService.js). One Zernio
 * account, one API key, one webhook endpoint — this module just parameterizes
 * the platform so WhatsApp and TikTok ride the existing plumbing.
 *
 * Profile management (per-workspace tenant isolation) is NOT duplicated here —
 * we import getDefaultProfileId/createProfile from the IG service so every
 * platform for a workspace connects under the same Zernio profile.
 *
 * Required env (shared with the IG service):
 *   BOTLIFY_IG_PROVIDER_BASE_URL   e.g. https://zernio.com/api/v1
 *   BOTLIFY_IG_PROVIDER_API_KEY    Bearer token (server-side, never exposed)
 */
const axios = require("axios");
const logger = require("../../utils/logger");
const {
  getDefaultProfileId,
  createProfile,
} = require("../instagram/botlifyIgService");

const BASE = (
  process.env.BOTLIFY_IG_PROVIDER_BASE_URL || "https://zernio.com/api/v1"
).replace(/\/$/, "");
const KEY = process.env.BOTLIFY_IG_PROVIDER_API_KEY;

// Platforms this service can connect. TikTok is deliberately absent: Zernio's
// API has NO TikTok DM or comment support (their spec excludes tiktok from the
// inbox platform enum entirely), so a TikTok account cannot power the
// concierge. TikTok remains possible later for posting/analytics only.
const PLATFORMS = ["whatsapp"];

// Platforms whose inbound messages the concierge can answer.
const DM_PLATFORMS = ["whatsapp", "instagram"];

const isConfigured = () =>
  !!KEY && KEY !== "your_zernio_api_key" && !KEY.startsWith("your_");

const isSupportedPlatform = (platform) =>
  PLATFORMS.includes(String(platform || "").toLowerCase());

const client = () =>
  axios.create({
    baseURL: BASE,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

// ── Hosted-auth flow ─────────────────────────────────────────────────────────

/**
 * Generate a hosted-auth URL the user is redirected to. Mirrors the IG flow:
 * GET /connect/{platform}?profileId=...&redirectUrl=... → { authUrl }.
 *
 * @param {object} opts
 * @param {string} opts.platform     "whatsapp" | "tiktok"
 * @param {string} [opts.profileId]  per-workspace Zernio profile (tenant isolation)
 * @param {string} [opts.callbackUrl] our /api/channels/:platform/callback
 * @returns {Promise<{url: string}>}
 */
const createHostedAuthLink = async ({ platform, profileId, callbackUrl, ...opts }) => {
  if (!isConfigured()) {
    throw new Error("Messaging provider not configured");
  }
  if (!isSupportedPlatform(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const pid = profileId || (await getDefaultProfileId());
  const params = { profileId: pid };
  // Zernio's OpenAPI spec documents `redirect_url`; our production Instagram
  // flow has always sent `redirectUrl` and works. Send both so we match the
  // spec without breaking the shape that is proven in production.
  if (callbackUrl) {
    params.redirectUrl = callbackUrl;
    params.redirect_url = callbackUrl;
  }
  // WhatsApp only: `api` runs Meta's Embedded Signup (WABA + number picker).
  // Omitting it defaults to coexistence with the consumer WhatsApp Business
  // app, which is not what a hotel connecting a business number wants.
  if (platform === "whatsapp") params.onboarding = opts.onboarding || "api";

  logger.info(`[ZernioSocial] creating ${platform} auth link`, {
    profileId: pid,
    callbackUrl,
  });
  const { data } = await client().get(
    `/connect/${encodeURIComponent(platform)}`,
    { params },
  );

  // Zernio returns { authUrl: "..." } per docs, but tolerate alternate keys.
  const url = data.authUrl || data.url || data.connectUrl || data.link;
  if (!url) {
    logger.error("[ZernioSocial] unexpected response shape", { data });
    throw new Error(
      `Provider did not return an auth URL. Keys: ${Object.keys(data || {}).join(", ")}`,
    );
  }
  return { url };
};

// ── Accounts ─────────────────────────────────────────────────────────────────

/**
 * List connected accounts for one platform, optionally scoped to a single
 * Zernio profile (tenant). Same endpoint the IG service uses — we just filter
 * on a different platform value.
 */
const listAccounts = async (platform, profileId) => {
  const { data } = await client().get("/accounts", {
    params: profileId ? { profileId } : undefined,
  });
  const accounts = Array.isArray(data) ? data : data?.accounts || [];
  return accounts
    .filter(
      (a) =>
        (a.platform || "").toLowerCase() ===
        String(platform || "").toLowerCase(),
    )
    .map((a) => ({
      accountId: a._id || a.id,
      profileId: a.profileId,
      platform: (a.platform || "").toLowerCase(),
      user_id: a.platformAccountId || a.platform_id || a._id,
      username: a.username || a.handle,
      name: a.displayName || a.name || a.username,
      profile_picture_url:
        a.profilePictureUrl || a.avatar || a.profilePicture || null,
      phone_number: a.phoneNumber || a.phone || null, // WhatsApp only
      followers_count: a.followers || a.followersCount || 0,
      createdAt: a.createdAt,
    }));
};

const getAccountInfo = async (accountId) => {
  const { data } = await client().get(
    `/accounts/${encodeURIComponent(accountId)}`,
  );
  return {
    accountId: data._id || data.id || accountId,
    platform: (data.platform || "").toLowerCase(),
    user_id: data.platformAccountId || data.platform_id || accountId,
    username: data.username || data.handle,
    name: data.displayName || data.name || data.username,
    profile_picture_url:
      data.profilePictureUrl || data.avatar || data.profilePicture || null,
    phone_number: data.phoneNumber || data.phone || null,
    followers_count: data.followers || data.followersCount || 0,
  };
};

// ── Messaging ────────────────────────────────────────────────────────────────

/**
 * Resolve a Zernio conversation id for a recipient when we don't already have
 * one. Zernio's send endpoint is keyed by conversationId, not recipient id.
 * Same lookup logic as the IG service.
 */
const resolveConversationId = async (accountId, recipientId) => {
  try {
    const { data } = await client().get("/inbox/conversations", {
      params: { accountId },
    });
    const list = Array.isArray(data)
      ? data
      : data?.data || data?.conversations || [];
    const target = String(recipientId);
    const match = list.find(
      (c) =>
        String(c.participantId) === target ||
        String(c.platformConversationId) === target ||
        String(c.participantUsername || "").toLowerCase() ===
          target.toLowerCase(),
    );
    return match?.id || null;
  } catch (err) {
    logger.warn("[ZernioSocial] resolveConversationId failed", {
      error: err.response?.data || err.message,
    });
    return null;
  }
};

/**
 * Send a DM. Signature mirrors botlifyIgService.sendDM so the transport
 * resolver can call either provider transparently. `opts.conversationId`
 * (delivered in the inbound webhook) is the fast path; without it we look the
 * conversation up by recipient.
 *
 * Zernio endpoint: POST /inbox/conversations/{conversationId}/messages
 *   body: { accountId, message, attachments? }
 */
/**
 * Meta rejects free-form WhatsApp messages sent more than 24h after the guest's
 * last message. The raw error is opaque, so detect it and say something the
 * hotel can act on.
 */
const isOutsideWindowError = (apiErr = {}) => {
  const blob = JSON.stringify(apiErr || {}).toLowerCase();
  return (
    blob.includes("re-engagement") ||
    blob.includes("outside the allowed window") ||
    blob.includes("131047") ||
    blob.includes("template required") ||
    blob.includes("template_required")
  );
};

const sendDM = async (accountId, recipientId, text, opts = {}) => {
  try {
    let conversationId = opts.conversationId || null;
    if (!conversationId) {
      conversationId = await resolveConversationId(accountId, recipientId);
    }
    if (!conversationId) {
      logger.error("[ZernioSocial] sendDM: no conversation id for recipient", {
        recipientId,
      });
      return {
        success: false,
        error:
          "No conversation found for this recipient. Replies are only possible inside an existing conversation.",
      };
    }

    // Normalize attachments: accept a single mediaUrl or a list, coerce to the
    // Zernio shape [{ type, url }].
    let attachments = null;
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      attachments = opts.attachments
        .map((a) =>
          typeof a === "string"
            ? { type: "image", url: a }
            : { type: a.type || "image", url: a.url },
        )
        .filter((a) => a.url);
    } else if (opts.mediaUrl) {
      attachments = [{ type: opts.mediaType || "image", url: opts.mediaUrl }];
    }

    const body = { accountId, message: text || "" };
    if (attachments && attachments.length) body.attachments = attachments;

    const { data } = await client().post(
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      body,
    );
    return {
      success: true,
      messageId: data?.id || data?.messageId || data?.data?.id,
    };
  } catch (err) {
    const apiErr = err.response?.data || {};
    const isRateLimit =
      err.response?.status === 429 ||
      /rate.?limit/i.test(apiErr.error || apiErr.message || "");
    logger.error("[ZernioSocial] sendDM error", {
      status: err.response?.status,
      error: apiErr,
      recipientId,
      conversationId: opts.conversationId,
      rateLimited: isRateLimit,
    });
    const outsideWindow = isOutsideWindowError(apiErr);
    return {
      success: false,
      rateLimited: isRateLimit,
      outsideWindow,
      error: outsideWindow
        ? "This guest last messaged over 24 hours ago, so WhatsApp only allows an approved template message. Ask them to message again, or send a template."
        : apiErr.error || apiErr.message || err.message,
    };
  }
};

// ── Webhook subscription ─────────────────────────────────────────────────────

/**
 * Make the provider forward events for this account to our public webhook —
 * the SAME endpoint the IG events arrive on; the receiver routes by account.
 * Idempotent — calling twice is safe.
 */
const subscribeWebhook = async (accountId, webhookUrl) => {
  if (!webhookUrl) {
    const base =
      process.env.API_PUBLIC_URL ||
      "https://velox-whatbot-backend.onrender.com";
    webhookUrl = `${base}/api/instagram/webhook/botlify`;
  }

  // Zernio's /webhooks/settings is profile-scoped and requires the profileId
  // (same requirement as the IG service).
  let profileId = null;
  try {
    profileId = await getDefaultProfileId();
  } catch {
    /* fall through — logged below if the call fails */
  }

  const events = [
    "message.received",
    "conversation.started",
    "comment.received",
    "reaction.received",
  ];

  const body = { profileId, accountId, url: webhookUrl, events };

  try {
    const { data } = await client().post("/webhooks/settings", body);
    return data;
  } catch (err) {
    logger.error("[ZernioSocial] subscribeWebhook rejected by provider", {
      status: err.response?.status,
      providerError: err.response?.data,
      sentKeys: Object.keys(body),
      profileId,
      accountId,
    });
    throw err;
  }
};

// ── Disconnect ───────────────────────────────────────────────────────────────

const disconnectAccount = async (accountId) => {
  try {
    await client().delete(`/accounts/${encodeURIComponent(accountId)}`);
    return { success: true };
  } catch (err) {
    logger.warn("[ZernioSocial] disconnect error", {
      error: err.response?.data || err.message,
    });
    return { success: false };
  }
};

module.exports = {
  PLATFORMS,
  DM_PLATFORMS,
  isConfigured,
  isSupportedPlatform,
  // profiles (multi-tenant) — re-exported from the IG service, single source
  createProfile,
  getDefaultProfileId,
  // hosted-auth flow
  createHostedAuthLink,
  // accounts
  listAccounts,
  getAccountInfo,
  // messaging
  sendDM,
  subscribeWebhook,
  disconnectAccount,
};
