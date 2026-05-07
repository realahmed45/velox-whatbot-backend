/**
 * Botlify — Instagram service dispatcher.
 *
 * Public re-export with provider routing based on the access-token prefix:
 *   - tokens starting with "zer:" → Botlify-hosted IG provider (white-label)
 *   - everything else            → direct Meta Graph API
 *
 * This lets every existing caller (jobs, automation engine, controller) keep
 * passing whatever string is stored in workspace.instagram.accessToken without
 * caring which provider is behind it.
 */
const meta = require("./metaService");
const botlify = require("./botlifyIgService");

const isBotlify = (token) =>
  typeof token === "string" && token.startsWith(botlify.TOKEN_PREFIX);

const route = (token) => (isBotlify(token) ? botlify : meta);

// Provider-routed functions (token is the first arg in every case)
const sendDM = (token, ...rest) => route(token).sendDM(token, ...rest);
const subscribeWebhook = (token, ...rest) =>
  route(token).subscribeWebhook(token, ...rest);
const getSubscribedApps = (token, ...rest) =>
  route(token).getSubscribedApps(token, ...rest);
const getIGAccountInfo = (token, ...rest) =>
  route(token).getIGAccountInfo(token, ...rest);
const publishPost = (token, ...rest) =>
  route(token).publishPost(token, ...rest);
const publishStory = (token, ...rest) =>
  route(token).publishStory(token, ...rest);
const hideComment = (token, ...rest) =>
  route(token).hideComment(token, ...rest);
const refreshLongLivedToken = (token, ...rest) =>
  route(token).refreshLongLivedToken(token, ...rest);
const getRecentFollowers = (token, ...rest) =>
  route(token).getRecentFollowers(token, ...rest);

// Meta-only OAuth helpers (called only on Meta-OAuth callback path)
const exchangeCodeForToken = meta.exchangeCodeForToken;
const getLongLivedToken = meta.getLongLivedToken;

module.exports = {
  // dispatcher helpers
  isBotlify,
  botlify,
  meta,
  // OAuth (Meta-only)
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  // Account / messaging / publishing — provider-routed
  getIGAccountInfo,
  getRecentFollowers,
  sendDM,
  subscribeWebhook,
  getSubscribedApps,
  publishPost,
  publishStory,
  hideComment,
};
