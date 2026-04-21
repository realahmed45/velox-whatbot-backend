/**
 * Botlify — Instagram Graph API Service
 * Uses the **Instagram API with Instagram Login** (not Facebook Login)
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const IG_API_VERSION = process.env.IG_API_VERSION || "v21.0";
const IG_GRAPH = `https://graph.instagram.com/${IG_API_VERSION}`;
const IG_OAUTH = "https://api.instagram.com/oauth/access_token";
const IG_OAUTH_LONG = `https://graph.instagram.com/access_token`;

// ── OAuth helpers ─────────────────────────────────────────────────────────────

/**
 * Exchange short-lived code → short-lived IG user access token
 * Returns { access_token, user_id, permissions }
 */
const exchangeCodeForToken = async (code, redirectUri) => {
  const params = new URLSearchParams();
  params.append("client_id", process.env.IG_APP_ID);
  params.append("client_secret", process.env.IG_APP_SECRET);
  params.append("grant_type", "authorization_code");
  params.append("redirect_uri", redirectUri);
  params.append("code", code);

  const { data } = await axios.post(IG_OAUTH, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return data;
};

/**
 * Upgrade short-lived (1 hour) → long-lived (60 days)
 */
const getLongLivedToken = async (shortToken) => {
  const { data } = await axios.get(IG_OAUTH_LONG, {
    params: {
      grant_type: "ig_exchange_token",
      client_secret: process.env.IG_APP_SECRET,
      access_token: shortToken,
    },
  });
  return data;
};

/**
 * Refresh a long-lived token (must be at least 24h old, extends another 60d)
 */
const refreshLongLivedToken = async (longToken) => {
  const { data } = await axios.get(`${IG_GRAPH}/refresh_access_token`, {
    params: {
      grant_type: "ig_refresh_token",
      access_token: longToken,
    },
  });
  return data;
};

/**
 * Get basic Instagram account info (username, name, followers, profile pic)
 */
const getIGAccountInfo = async (accessToken) => {
  const { data } = await axios.get(`${IG_GRAPH}/me`, {
    params: {
      fields:
        "user_id,username,name,profile_picture_url,followers_count,account_type",
      access_token: accessToken,
    },
  });
  return data;
};

// ── Messaging ─────────────────────────────────────────────────────────────────

/**
 * Send a DM to an Instagram user via Instagram Login API
 * POST https://graph.instagram.com/v21.0/me/messages
 */
const sendDM = async (accessToken, recipientIgId, text) => {
  try {
    const { data } = await axios.post(
      `${IG_GRAPH}/me/messages`,
      {
        recipient: { id: recipientIgId },
        message: { text },
      },
      {
        params: { access_token: accessToken },
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
      },
    );
    return { success: true, messageId: data.message_id };
  } catch (err) {
    logger.error("Instagram sendDM error", {
      error: err.response?.data || err.message,
      recipientIgId,
    });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Get recent followers for the authenticated IG Business/Creator account.
 * Returns an array of { id, username } objects (first page, up to 50).
 * Requires instagram_business_basic permission.
 */
// NOTE: Instagram Graph API does NOT expose a /me/followers endpoint.
// Follower-based DM automation is not supported by the API.
// This function is kept as a stub so existing code doesn't break.
const getRecentFollowers = async (_accessToken, _limit = 50) => {
  logger.warn("getRecentFollowers: Instagram API does not support fetching followers list — returning empty");
  return [];
};

/**
 * Subscribe the IG account to webhook events
 * NOTE: Instagram API does NOT provide a 'follows' webhook - use polling instead
 */
const subscribeWebhook = async (accessToken) => {
  const { data } = await axios.post(`${IG_GRAPH}/me/subscribed_apps`, null, {
    params: {
      subscribed_fields: "messages,messaging_postbacks,messaging_seen,comments",
      access_token: accessToken,
    },
  });
  return data;
};

module.exports = {
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getIGAccountInfo,
  getRecentFollowers,
  sendDM,
  subscribeWebhook,
};
