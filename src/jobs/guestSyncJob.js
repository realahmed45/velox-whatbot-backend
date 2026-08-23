/**
 * Guest sync — keeps unified Guest profiles current without bookingService
 * having to know they exist.
 *
 * Every hour we sweep bookings touched in the last 2 days and re-derive their
 * guest. upsertGuestFromBooking recomputes stats from scratch, so re-seeing the
 * same booking on the next pass is a no-op, not a double count. The 2-day look
 * back (rather than a stored high-water mark) is deliberate: one number less to
 * keep correct, and it self-heals after downtime.
 */
const HotelBooking = require("../models/HotelBooking");
const logger = require("../utils/logger");
const { upsertGuestFromBooking } = require("../services/hotel/guestService");

const LOOKBACK_DAYS = 2;
const MAX_PER_RUN = 500;

const syncGuests = async () => {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const bookings = await HotelBooking.find({
    $or: [{ createdAt: { $gte: since } }, { updatedAt: { $gte: since } }],
  })
    .sort({ updatedAt: 1 })
    .limit(MAX_PER_RUN)
    .lean();

  let synced = 0;
  for (const booking of bookings) {
    try {
      const guest = await upsertGuestFromBooking(booking);
      if (guest) synced++;
    } catch (err) {
      logger.warn(
        `[cron:guestSync] booking=${booking._id} failed: ${err.message}`,
      );
    }
  }

  if (bookings.length) {
    logger.info(
      `[cron:guestSync] ${synced}/${bookings.length} bookings synced to guest profiles`,
    );
  }
  return { scanned: bookings.length, synced };
};

module.exports = { syncGuests };
