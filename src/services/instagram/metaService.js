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
 * Subscribe the IG account to webhook events
 */
const subscribeWebhook = async (accessToken) => {
  const { data } = await axios.post(
    `${IG_GRAPH}/me/subscribed_apps`,
    null,
    {
      params: {
        subscribed_fields:
          "messages,messaging_postbacks,messaging_seen,comments",
        access_token: accessToken,
      },
    },
  );
  return data;
};

module.exports = {
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getIGAccountInfo,
  sendDM,
  subscribeWebhook,
};
/**
 * Flowgram — Instagram Graph API Service
 * Official Meta API for Instagram DM automation
 * Docs: https://developers.facebook.com/docs/instagram-api/guides/messaging
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const META_API_VERSION = process.env.META_API_VERSION || "v19.0";
const META_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// ── OAuth helpers ─────────────────────────────────────────────────────────────

/**
 * Exchange a short-lived code for a long-lived access token
 */
const exchangeCodeForToken = async (code, redirectUri) => {
  const { data } = await axios.get(`${META_BASE}/oauth/access_token`, {
    params: {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    },
  });
  return data; // { access_token, token_type }
};

/**
 * Upgrade a short-lived token to long-lived (60 days)
 */
const getLongLivedToken = async (shortToken) => {
  const { data } = await axios.get(`${META_BASE}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  return data; // { access_token, token_type, expires_in }
};

/**
 * Get the Instagram Business Account ID linked to a Facebook Page
 */
const getIGAccountId = async (pageId, accessToken) => {
  const { data } = await axios.get(`${META_BASE}/${pageId}`, {
    params: {
      fields: "instagram_business_account",
      access_token: accessToken,
    },
  });
  return data?.instagram_business_account?.id || null;
};

/**
 * Get basic Instagram account info
 */
const getIGAccountInfo = async (igUserId, accessToken) => {
  const { data } = await axios.get(`${META_BASE}/${igUserId}`, {
    params: {
      fields: "id,username,name,profile_picture_url,followers_count",
      access_token: accessToken,
    },
  });
  return data;
};

/**
 * Get Facebook Pages the user manages
 */
const getUserPages = async (userAccessToken) => {
  const { data } = await axios.get(`${META_BASE}/me/accounts`, {
    params: {
      access_token: userAccessToken,
      fields: "id,name,access_token,instagram_business_account",
    },
  });
  return data?.data || [];
};

// ── Messaging ─────────────────────────────────────────────────────────────────

/**
 * Send a DM to an Instagram user
 * @param {string} igUserId - The IG account (yours)
 * @param {string} accessToken - Page access token
 * @param {string} recipientIgId - Recipient's IG scoped user ID
 * @param {string} text - Message text
 */
const sendDM = async (igUserId, accessToken, recipientIgId, text) => {
  try {
    const { data } = await axios.post(
      `${META_BASE}/${igUserId}/messages`,
      {
        recipient: { id: recipientIgId },
        message: { text },
        messaging_type: "MESSAGE_TAG",
        tag: "HUMAN_AGENT",
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
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
 * Subscribe a page to the Instagram webhook
 */
const subscribeWebhook = async (pageId, accessToken) => {
  const { data } = await axios.post(
    `${META_BASE}/${pageId}/subscribed_apps`,
    null,
    {
      params: {
        subscribed_fields: "messages,message_reactions,messaging_seen",
        access_token: accessToken,
      },
    },
  );
  return data;
};

module.exports = {
  exchangeCodeForToken,
  getLongLivedToken,
  getIGAccountId,
  getIGAccountInfo,
  getUserPages,
  sendDM,
  subscribeWebhook,
};
