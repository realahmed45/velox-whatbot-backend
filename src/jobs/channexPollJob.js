/**
 * Channex booking poll — the safety net under the Channex booking webhook.
 *
 * Our webhook acks 200 immediately and processes asynchronously, which is the
 * right thing to do for latency but means a failure after the ack is invisible:
 * Channex retries only on 5xx, so a booking that threw while we were storing it
 * would never be re-delivered. The hotel would find out when a guest arrived
 * with a reservation Botlify never recorded.
 *
 * Channex's own docs call the booking revisions feed "the primary way to get
 * bookings", and that is how we treat it — the webhook is a latency
 * optimisation on top. A revision stays in the feed until we explicitly ack it,
 * so anything that fails is retried on the next run rather than lost, and
 * out-of-order webhook delivery self-corrects because the feed is ordered.
 */
const logger = require("../utils/logger");
const channex = require("../services/channels/channexService");

const pollChannexBookings = async () => {
  if (!channex.isConfigured()) return { ok: false, reason: "not_configured" };
  try {
    return await channex.pollBookingRevisions();
  } catch (err) {
    logger.warn("[cron:channexPoll] failed: " + err.message);
    return { ok: false, reason: err.message };
  }
};

module.exports = { pollChannexBookings };
