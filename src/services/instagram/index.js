/**
 * Botlify — Instagram service.
 *
 * All calls are routed through the Zernio-hosted provider (botlifyIgService).
 * Tokens stored on the workspace always start with the "zer:" prefix.
 */
const botlify = require("./botlifyIgService");

module.exports = {
  // Provider reference (for internal helpers that need raw access)
  botlify,
  // OAuth helpers
  exchangeCodeForToken: botlify.exchangeCodeForToken,
  getLongLivedToken: botlify.getLongLivedToken,
  refreshLongLivedToken: botlify.refreshLongLivedToken,
  // Account / messaging / publishing
  getIGAccountInfo: botlify.getIGAccountInfo,
  getRecentFollowers: botlify.getRecentFollowers,
  sendDM: botlify.sendDM,
  subscribeWebhook: botlify.subscribeWebhook,
  getSubscribedApps: botlify.getSubscribedApps,
  publishPost: botlify.publishPost,
  publishStory: botlify.publishStory,
  hideComment: botlify.hideComment,
};
