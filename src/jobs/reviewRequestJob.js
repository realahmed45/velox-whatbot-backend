/**
 * Post-checkout review request job.
 *
 * Runs daily. Finds stays that checked out yesterday through OUR channels and
 * asks the guest for feedback — once. reviewService.requestReview() stamps the
 * booking with reviewRequestedAt so a guest is never asked twice.
 *
 * OTA-sourced bookings are skipped (the service enforces this too) — messaging
 * a Booking.com / Airbnb guest outside the OTA breaks their terms.
 */
const HotelBooking = require("../models/HotelBooking");
const { requestReview, DIRECT_SOURCES } = require("../services/reputation/reviewService");
const logger = require("../utils/logger");

async function runReviewRequests() {
  // Yesterday, UTC.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const bookings = await HotelBooking.find({
    checkOut: { $gte: start, $lt: end },
    status: "completed",
    source: { $in: DIRECT_SOURCES },
    conversationId: { $ne: null },
    reviewRequestedAt: { $in: [null, undefined] },
  }).limit(500);

  logger.info(`[ReviewRequest] ${bookings.length} stays checked out yesterday`);
  let sent = 0;

  for (const booking of bookings) {
    try {
      const result = await requestReview({ booking });
      if (result.ok) sent++;
    } catch (err) {
      logger.warn(
        `[ReviewRequest] booking ${booking._id} failed: ${err.message}`,
      );
    }
  }

  logger.info(`[ReviewRequest] done. sent:${sent}`);
  return { checked: bookings.length, sent };
}

module.exports = { runReviewRequests };
