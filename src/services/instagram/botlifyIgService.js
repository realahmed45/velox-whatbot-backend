/**
 * Botlify — Instagram (Hosted Provider) Service
 *
 * White-labeled wrapper around an upstream hosted-OAuth provider that gives us
 * Instagram messaging without per-tenant Meta App Review. Customers never see
 * the provider name. Internally we call them via env-configured base URL +
 * API key.
 *
 * Token shape stored in the workspace looks like: "zer:<accountId>"
 *  - the dispatcher in ./index.js routes any token starting with "zer:" here.
 *  - <accountId> is the upstream provider's account/connection id.
 *
 * Required env:
 *   BOTLIFY_IG_PROVIDER_BASE_URL   e.g. https://zernio.com/api/v1
 *   BOTLIFY_IG_PROVIDER_API_KEY    Bearer token (server-side, never exposed)
 *   BOTLIFY_IG_PROVIDER_PROFILE_ID (optional) default workspace/profile id
 *   BOTLIFY_IG_PROVIDER_WEBHOOK_SECRET  shared secret for inbound HMAC check
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const BASE = (
  process.env.BOTLIFY_IG_PROVIDER_BASE_URL || "https://zernio.com/api/v1"
).replace(/\/$/, "");
const KEY = process.env.BOTLIFY_IG_PROVIDER_API_KEY;
const DEFAULT_PROFILE_ID = process.env.BOTLIFY_IG_PROVIDER_PROFILE_ID || null;

const TOKEN_PREFIX = "zer:";

const isConfigured = () =>
  !!KEY && KEY !== "your_zernio_api_key" && !KEY.startsWith("your_");

const client = () =>
  axios.create({
    baseURL: BASE,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

const stripPrefix = (token) =>
  typeof token === "string" && token.startsWith(TOKEN_PREFIX)
    ? token.slice(TOKEN_PREFIX.length)
    : token;

const wrapAccountId = (accountId) => `${TOKEN_PREFIX}${accountId}`;

// ── Hosted-auth flow ─────────────────────────────────────────────────────────

/**
 * Generate a hosted-auth URL the user is redirected to. Provider returns a
 * one-time URL that walks the user through Instagram login + permissions.
 *
 * @param {object} opts
 * @param {string} opts.state  base64-encoded JSON { workspaceId, userId }
 * @param {string} opts.callbackUrl  our /api/instagram/connect/callback-botlify
 * @returns {Promise<{url: string}>}
 */
const createHostedAuthLink = async ({ state, callbackUrl }) => {
  if (!isConfigured()) {
    throw new Error("Instagram hosted provider not configured");
  }
  // Zernio uses GET /connect/instagram?profileId=... (not POST with body)
  const params = {};
  if (DEFAULT_PROFILE_ID) params.profileId = DEFAULT_PROFILE_ID;
  // Some Zernio plans accept a redirectUrl / successUrl query param
  if (callbackUrl) params.redirectUrl = callbackUrl;

  logger.info("[Zernio] creating auth link", { params });
  const { data } = await client().get("/connect/instagram", { params });
  logger.info("[Zernio] auth link response", { keys: Object.keys(data || {}) });

  // Zernio returns { authUrl: "..." } per docs, but tolerate alternate keys
  const url = data.authUrl || data.url || data.connectUrl || data.link;
  if (!url) {
    logger.error("[Zernio] unexpected response shape", { data });
    throw new Error(
      `Provider did not return an auth URL. Keys: ${Object.keys(data).join(", ")}`,
    );
  }
  return { url };
};

/**
 * Exchange the provider's callback `code` (or `accountId` directly) for an
 * account record we persist on the workspace.
 */
const exchangeCallback = async ({ code, accountId }) => {
  if (!isConfigured()) {
    throw new Error("Instagram hosted provider not configured");
  }
  // If Zernio fires account.connected webhook with accountId directly, use it.
  if (accountId) {
    const info = await getAccountInfo(accountId);
    return { accountId, info };
  }
  // Fallback: exchange code via accounts list (Zernio doesn't have a /exchange endpoint)
  // The account should already be connected; look it up by listing accounts.
  const { data } = await client().get("/accounts", {
    params: { platform: "instagram" },
  });
  const accounts = Array.isArray(data) ? data : data?.accounts || [];
  const acc = accounts[0];
  if (!acc?._id) throw new Error("No Instagram account found after OAuth");
  const info = await getAccountInfo(acc._id);
  return { accountId: acc._id, info };
};

// ── Account lookup ───────────────────────────────────────────────────────────

const getAccountInfo = async (accountIdOrToken) => {
  const accountId = stripPrefix(accountIdOrToken);
  const { data } = await client().get(`/accounts/${accountId}`);
  // Normalize to the shape the rest of the app expects (mirrors metaService.getIGAccountInfo)
  return {
    user_id: data.platformAccountId || data.platform_id || accountId,
    username: data.username || data.handle,
    name: data.displayName || data.name || data.username,
    profile_picture_url: data.avatar || data.profilePicture || null,
    followers_count: data.followers || data.followersCount || 0,
    account_type: data.accountType || "BUSINESS",
  };
};

// ── Messaging ────────────────────────────────────────────────────────────────

/**
 * Send a DM. Signature mirrors metaService.sendDM(accessToken, recipientId, text)
 * so the dispatcher can call either provider transparently.
 */
const sendDM = async (accountIdOrToken, recipientIgId, text) => {
  try {
    const accountId = stripPrefix(accountIdOrToken);
    const { data } = await client().post("/inbox/messages", {
      accountId,
      platform: "instagram",
      recipientId: recipientIgId,
      content: { text },
    });
    return { success: true, messageId: data.id || data.messageId };
  } catch (err) {
    const apiErr = err.response?.data || {};
    const isRateLimit =
      err.response?.status === 429 ||
      /rate.?limit/i.test(apiErr.error || apiErr.message || "");
    logger.error("[BotlifyIG] sendDM error", {
      error: apiErr,
      recipientIgId,
      rateLimited: isRateLimit,
    });
    return {
      success: false,
      rateLimited: isRateLimit,
      error: apiErr.error || apiErr.message || err.message,
    };
  }
};

// ── Webhook subscription ─────────────────────────────────────────────────────

/**
 * Make the upstream provider forward IG events to our public webhook.
 * Idempotent — calling twice is safe.
 */
const subscribeWebhook = async (accountIdOrToken, webhookUrl) => {
  if (!webhookUrl) {
    const base =
      process.env.API_PUBLIC_URL ||
      "https://velox-whatbot-backend.onrender.com";
    webhookUrl = `${base}/api/instagram/webhook/botlify`;
  }
  const accountId = stripPrefix(accountIdOrToken);
  const { data } = await client().post("/webhooks/settings", {
    accountId,
    url: webhookUrl,
    events: ["message.received", "comment.received", "story.mention"],
  });
  return data;
};

const getSubscribedApps = async (accountIdOrToken) => {
  // Match the shape metaService returns so diagnose() works.
  try {
    const accountId = stripPrefix(accountIdOrToken);
    const { data } = await client().get(`/webhooks/settings`, {
      params: { accountId },
    });
    const subs = Array.isArray(data) ? data : data?.data || [];
    if (!subs.length) return [];
    return [
      {
        name: "botlify",
        subscribed_fields: subs[0]?.events || [
          "messages",
          "comments",
          "story_mentions",
        ],
      },
    ];
  } catch (e) {
    return [];
  }
};

// ── Publishing ───────────────────────────────────────────────────────────────

const publishPost = async (
  accountIdOrToken,
  _igUserId,
  imageUrl,
  caption = "",
) => {
  try {
    const accountId = stripPrefix(accountIdOrToken);
    const { data } = await client().post("/posts", {
      accountId,
      platforms: [{ platform: "instagram", accountId }],
      content: caption,
      mediaItems: [{ type: "image", url: imageUrl }],
    });
    return { success: true, mediaId: data.id || data.postId };
  } catch (err) {
    logger.error("[BotlifyIG] publishPost error", {
      error: err.response?.data || err.message,
    });
    return {
      success: false,
      error: err.response?.data?.error || err.message,
    };
  }
};

const publishStory = async (accountIdOrToken, _igUserId, imageUrl) => {
  try {
    const accountId = stripPrefix(accountIdOrToken);
    const { data } = await client().post("/posts", {
      accountId,
      platforms: [{ platform: "instagram", accountId }],
      contentType: "story",
      mediaItems: [{ type: "image", url: imageUrl }],
    });
    return { success: true, mediaId: data.id || data.postId };
  } catch (err) {
    logger.error("[BotlifyIG] publishStory error", {
      error: err.response?.data || err.message,
    });
    return {
      success: false,
      error: err.response?.data?.error || err.message,
    };
  }
};

const hideComment = async (accountIdOrToken, commentId) => {
  try {
    const accountId = stripPrefix(accountIdOrToken);
    const { data } = await client().post(`/comments/${commentId}/hide`, {
      accountId,
    });
    return { success: true, data };
  } catch (err) {
    logger.warn("[BotlifyIG] hideComment error", {
      commentId,
      error: err.response?.data || err.message,
    });
    return {
      success: false,
      error: err.response?.data?.error || err.message,
    };
  }
};

// ── Stubs (kept so dispatcher can route uniformly) ───────────────────────────

const exchangeCodeForToken = async () => {
  throw new Error("exchangeCodeForToken not used by hosted provider");
};
const getLongLivedToken = async (token) => ({
  access_token: token,
  expires_in: 60 * 24 * 3600,
});
const refreshLongLivedToken = async (token) => ({
  access_token: token,
  expires_in: 60 * 24 * 3600,
});
const getRecentFollowers = async () => [];

// ── Disconnect ───────────────────────────────────────────────────────────────

const disconnectAccount = async (accountIdOrToken) => {
  try {
    const accountId = stripPrefix(accountIdOrToken);
    await client().delete(`/accounts/${accountId}`);
    return { success: true };
  } catch (err) {
    logger.warn("[BotlifyIG] disconnect error", {
      error: err.response?.data || err.message,
    });
    return { success: false };
  }
};

module.exports = {
  TOKEN_PREFIX,
  isConfigured,
  wrapAccountId,
  stripPrefix,
  // hosted-auth flow
  createHostedAuthLink,
  exchangeCallback,
  // dispatcher-compatible API (matches metaService shape)
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getIGAccountInfo: getAccountInfo,
  getRecentFollowers,
  sendDM,
  subscribeWebhook,
  getSubscribedApps,
  publishPost,
  publishStory,
  hideComment,
  disconnectAccount,
};
