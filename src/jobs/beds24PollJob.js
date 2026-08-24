/**
 * Beds24 booking poll — the safety net under the Beds24 booking webhook.
 *
 * Beds24 booking webhooks cannot be registered through API V2 (the wiki FAQ is
 * explicit that webhook management is "coming soon"); the hotel has to paste our
 * callback URL into Settings > Properties > Access > Booking webhooks by hand.
 * Until they do, nothing would arrive — so we poll as well. It stays useful
 * afterwards too: Beds24 retries a failed webhook for 30 minutes and then gives
 * up, and a booking that never arrived is exactly the silent failure this
 * codebase tries hardest to avoid.
 *
 * Every 2 minutes we ask for bookings modified in the last 10 — a deliberate
 * overlap so a slow run or a brief outage doesn't punch a hole in the window.
 * Re-seeing a booking is free: ingestOtaBooking is idempotent on
 * otaReservationId, so a repeat is an update in place, not a duplicate.
 */
const logger = require("../utils/logger");
const beds24 = require("../services/channels/beds24Service");

// Wider than the 2-minute cadence on purpose — see above.
const LOOKBACK_MINUTES = 10;

const pollBeds24Bookings = async () => {
  if (!beds24.isConfigured()) return { ok: false, reason: "not_configured" };
  try {
    return await beds24.pollBookings({ sinceMinutes: LOOKBACK_MINUTES });
  } catch (err) {
    logger.warn("[cron:beds24Poll] failed: " + err.message);
    return { ok: false, reason: err.message };
  }
};

module.exports = { pollBeds24Bookings };
