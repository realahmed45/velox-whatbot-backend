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
        "id,user_id,username,name,profile_picture_url,followers_count,account_type",
      access_token: accessToken,
    },
  });
  return data;
};

/**
 * Look up a customer's IG profile by IGSID (the sender id from a webhook).
 * Returns { name, profile_pic } or null if the lookup fails.
 * NOTE: Instagram Login API does NOT expose `username` for DM senders —
 * only `name` and `profile_pic` are available. The `name` field will hold
 * the user's display name (e.g. "Ahmed Khan") which we use as the contact
 * display name. The IGSID itself remains as the unique identifier.
 */
const getIgUserProfile = async (accessToken, igsid) => {
  if (!accessToken || !igsid) return null;
  try {
    const { data } = await axios.get(`${IG_GRAPH}/${igsid}`, {
      params: {
        fields: "name,profile_pic",
        access_token: accessToken,
      },
      timeout: 8000,
    });
    logger.info(
      `[IG profile] resolved ${igsid} -> name="${data?.name || "(none)"}"`,
    );
    return data || null;
  } catch (err) {
    logger.warn(
      `[IG profile] lookup failed for ${igsid}: ${err.response?.data?.error?.message || err.message}`,
    );
    return null;
  }
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
    const apiErr = err.response?.data?.error || {};
    const isRateLimit =
      apiErr.code === 4 ||
      apiErr.code === 17 ||
      apiErr.code === 32 ||
      apiErr.code === 613 ||
      apiErr.error_subcode === 2018278;
    logger.error("Instagram sendDM error", {
      error: err.response?.data || err.message,
      recipientIgId,
      rateLimited: isRateLimit,
    });
    return {
      success: false,
      rateLimited: isRateLimit,
      code: apiErr.code,
      subcode: apiErr.error_subcode,
      error: apiErr.message || err.message,
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
  logger.warn(
    "getRecentFollowers: Instagram API does not support fetching followers list — returning empty",
  );
  return [];
};

/**
 * Subscribe the IG account to webhook events
 * NOTE: Instagram API does NOT provide a 'follows' webhook - use polling instead
 */
const subscribeWebhook = async (accessToken) => {
  const { data } = await axios.post(`${IG_GRAPH}/me/subscribed_apps`, null, {
    params: {
      subscribed_fields: [
        "messages",
        "messaging_postbacks",
        "messaging_seen",
        "messaging_referral",
        "message_reactions",
        "comments",
        "live_comments",
      ].join(","),
      access_token: accessToken,
    },
  });
  return data;
};

/**
 * Read back what this IG account is actually subscribed to on this app.
 * Returns an array like [{ name, subscribed_fields: [...] }] — empty array
 * means the app is NOT receiving events for this account, even if the POST
 * above returned success (common when the app's Webhooks product isn't
 * configured with a callback URL + fields in Meta App Dashboard).
 */
const getSubscribedApps = async (accessToken) => {
  const { data } = await axios.get(`${IG_GRAPH}/me/subscribed_apps`, {
    params: { access_token: accessToken },
  });
  return data?.data || [];
};

/**
 * Publish a photo post to Instagram
 * Two-step process:
 * 1. Create media container
 * 2. Publish the container
 *
 * @param {string} accessToken - Instagram access token
 * @param {string} igUserId - Instagram user ID
 * @param {string} imageUrl - Publicly accessible image URL (must be HTTPS)
 * @param {string} caption - Post caption (optional)
 * @returns {Promise<{success: boolean, mediaId?: string, error?: string}>}
 */
const publishPost = async (accessToken, igUserId, imageUrl, caption = "") => {
  try {
    // Step 1: Create media container
    const { data: containerData } = await axios.post(
      `${IG_GRAPH}/${igUserId}/media`,
      {
        image_url: imageUrl,
        caption: caption,
      },
      {
        params: { access_token: accessToken },
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      },
    );

    const containerId = containerData.id;
    if (!containerId) {
      throw new Error("No container ID returned from Instagram");
    }

    // Step 2: Publish the container
    const { data: publishData } = await axios.post(
      `${IG_GRAPH}/${igUserId}/media_publish`,
      {
        creation_id: containerId,
      },
      {
        params: { access_token: accessToken },
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      },
    );

    return {
      success: true,
      mediaId: publishData.id,
    };
  } catch (err) {
    logger.error("Instagram publishPost error", {
      error: err.response?.data || err.message,
      imageUrl,
    });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Publish an Instagram Story (C6).
 * Uses media_type=STORIES on the container create call, then publishes.
 * Supports image stories. Video stories require video_url + upload polling
 * which we can layer in later if needed.
 */
const publishStory = async (accessToken, igUserId, imageUrl) => {
  try {
    const { data: containerData } = await axios.post(
      `${IG_GRAPH}/${igUserId}/media`,
      {
        image_url: imageUrl,
        media_type: "STORIES",
      },
      {
        params: { access_token: accessToken },
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      },
    );
    const containerId = containerData.id;
    if (!containerId) throw new Error("No container ID returned for story");

    const { data: publishData } = await axios.post(
      `${IG_GRAPH}/${igUserId}/media_publish`,
      { creation_id: containerId },
      {
        params: { access_token: accessToken },
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      },
    );
    return { success: true, mediaId: publishData.id };
  } catch (err) {
    logger.error("Instagram publishStory error", {
      error: err.response?.data || err.message,
      imageUrl,
    });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

/**
 * Hide or delete a comment on a post.
 * IG Graph API: POST /{comment-id}?hide=true
 */
const hideComment = async (accessToken, commentId) => {
  try {
    const { data } = await axios.post(`${IG_GRAPH}/${commentId}`, null, {
      params: { hide: "true", access_token: accessToken },
      timeout: 10000,
    });
    return { success: true, data };
  } catch (err) {
    logger.warn("Instagram hideComment error", {
      commentId,
      error: err.response?.data || err.message,
    });
    return {
      success: false,
      error: err.response?.data?.error?.message || err.message,
    };
  }
};

module.exports = {
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getIGAccountInfo,
  getIgUserProfile,
  getRecentFollowers,
  sendDM,
  subscribeWebhook,
  getSubscribedApps,
  publishPost,
  publishStory,
  hideComment,
};
