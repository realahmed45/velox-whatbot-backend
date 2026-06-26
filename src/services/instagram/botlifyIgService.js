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

// ── Profiles ─────────────────────────────────────────────────────────────────

let _cachedProfileId = null;

/**
 * Resolve a Zernio profile id to connect accounts under. Uses the configured
 * env id when present, otherwise fetches the account's default profile.
 */
const getDefaultProfileId = async () => {
  if (DEFAULT_PROFILE_ID) return DEFAULT_PROFILE_ID;
  if (_cachedProfileId) return _cachedProfileId;
  const { data } = await client().get("/profiles");
  const profiles = Array.isArray(data) ? data : data?.profiles || [];
  const def = profiles.find((p) => p.isDefault) || profiles[0];
  if (!def?._id) throw new Error("No Zernio profile available");
  _cachedProfileId = def._id;
  return _cachedProfileId;
};

/**
 * List Instagram accounts connected to the Zernio workspace, normalized to the
 * shape the rest of the app expects.
 */
const listInstagramAccounts = async () => {
  const { data } = await client().get("/accounts");
  const accounts = Array.isArray(data) ? data : data?.accounts || [];
  return accounts
    .filter((a) => (a.platform || "").toLowerCase() === "instagram")
    .map((a) => ({
      accountId: a._id || a.id,
      profileId: a.profileId,
      user_id: a.platformAccountId || a.platform_id || a._id,
      username: a.username || a.handle,
      name: a.displayName || a.name || a.username,
      profile_picture_url:
        a.profilePictureUrl || a.avatar || a.profilePicture || null,
      followers_count: a.followers || a.followersCount || 0,
      account_type: a.accountType || "BUSINESS",
      createdAt: a.createdAt,
    }));
};

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
  // Zernio uses GET /connect/instagram?profileId=...&redirectUrl=... (not POST)
  const profileId = await getDefaultProfileId();
  const params = { profileId };
  // After the user authorizes, Zernio redirects the browser here. We embed our
  // workspace id in the callbackUrl query so the callback knows which workspace
  // to attach the freshly-connected account to.
  if (callbackUrl) params.redirectUrl = callbackUrl;

  logger.info("[Zernio] creating auth link", { profileId, callbackUrl });
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
const exchangeCallback = async ({ accountId, excludeAccountIds = [] }) => {
  if (!isConfigured()) {
    throw new Error("Instagram hosted provider not configured");
  }
  // If we already know the accountId (e.g. from webhook), look it up directly.
  const accounts = await listInstagramAccounts();
  if (!accounts.length) {
    throw new Error("No Instagram account found after OAuth");
  }

  let acc;
  if (accountId) {
    acc = accounts.find((a) => a.accountId === stripPrefix(accountId));
  }
  // Otherwise pick the IG account not already claimed by another workspace.
  if (!acc) {
    const exclude = new Set(excludeAccountIds);
    const unclaimed = accounts.filter((a) => !exclude.has(a.accountId));
    const pool = unclaimed.length ? unclaimed : accounts;
    // newest first
    pool.sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );
    acc = pool[0];
  }

  if (!acc?.accountId)
    throw new Error("No Instagram account found after OAuth");
  return {
    accountId: acc.accountId,
    info: acc,
  };
};

// ── Account lookup ───────────────────────────────────────────────────────────

const getAccountInfo = async (accountIdOrToken) => {
  const accountId = stripPrefix(accountIdOrToken);
  try {
    const { data } = await client().get(`/accounts/${accountId}`);
    return {
      user_id: data.platformAccountId || data.platform_id || accountId,
      username: data.username || data.handle,
      name: data.displayName || data.name || data.username,
      profile_picture_url:
        data.profilePictureUrl || data.avatar || data.profilePicture || null,
      followers_count: data.followers || data.followersCount || 0,
      account_type: data.accountType || "BUSINESS",
    };
  } catch (err) {
    // Zernio may not expose a single-account GET — fall back to the list.
    const accounts = await listInstagramAccounts();
    const acc = accounts.find((a) => a.accountId === accountId);
    if (acc) return acc;
    throw err;
  }
};

// ── Messaging ────────────────────────────────────────────────────────────────

/**
 * Resolve a Zernio conversation id for a recipient when we don't already have
 * one (e.g. for broadcasts / proactive sends not triggered by a webhook).
 * Zernio's send endpoint is keyed by conversationId, not recipient id.
 */
const resolveConversationId = async (accountId, recipientIgId) => {
  try {
    const { data } = await client().get("/inbox/conversations", {
      params: { accountId },
    });
    const list = Array.isArray(data)
      ? data
      : data?.data || data?.conversations || [];
    const target = String(recipientIgId);
    const match = list.find(
      (c) =>
        String(c.participantId) === target ||
        String(c.platformConversationId) === target ||
        String(c.participantUsername || "").toLowerCase() ===
          target.toLowerCase(),
    );
    return match?.id || null;
  } catch (err) {
    logger.warn("[BotlifyIG] resolveConversationId failed", {
      error: err.response?.data || err.message,
    });
    return null;
  }
};

/**
 * Send a DM. Signature mirrors metaService.sendDM(accessToken, recipientId, text)
 * so the dispatcher can call either provider transparently. `opts.conversationId`
 * (Zernio's platform conversation id, delivered in the inbound webhook) is the
 * fast path; without it we look the conversation up by recipient.
 *
 * Zernio endpoint: POST /v1/inbox/conversations/{conversationId}/messages
 *   body: { accountId, message, attachments? }
 *
 * `opts.mediaUrl` (single) or `opts.attachments` ([{ type, url }]) attach media
 * to the message — used so the AI bot can reply with a menu/catalog image.
 */
const sendDM = async (accountIdOrToken, recipientIgId, text, opts = {}) => {
  try {
    const accountId = stripPrefix(accountIdOrToken);
    let conversationId = opts.conversationId || null;
    if (!conversationId) {
      conversationId = await resolveConversationId(accountId, recipientIgId);
    }
    if (!conversationId) {
      logger.error("[BotlifyIG] sendDM: no conversation id for recipient", {
        recipientIgId,
      });
      return {
        success: false,
        error:
          "No Instagram conversation found for this recipient. Instagram only allows replies inside an existing 24h conversation window.",
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
    logger.error("[BotlifyIG] sendDM error", {
      status: err.response?.status,
      error: apiErr,
      recipientIgId,
      conversationId: opts.conversationId,
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
    events: [
      "message.received",
      "comment.received",
      "story.mention",
      "story.reply",
    ],
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
  getDefaultProfileId,
  listInstagramAccounts,
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
