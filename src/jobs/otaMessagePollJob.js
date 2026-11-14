/**
 * OTA guest-message poll — every minute, pull new messages from the guests'
 * Airbnb / Booking.com / Expedia inboxes (via the channel manager) and let the
 * AI answer them. Webhooks are the fast path where the provider offers them;
 * this guarantees nothing is missed. See services/hotel/otaMessageService.js.
 */
const logger = require("../utils/logger");
const otaMessages = require("../services/hotel/otaMessageService");

const pollOtaMessages = async () => {
  try {
    return await otaMessages.poll();
  } catch (err) {
    logger.warn("[cron:otaMessages] failed: " + err.message);
    return { ok: false, reason: err.message };
  }
};

module.exports = { pollOtaMessages };
