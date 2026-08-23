/**
 * Pre-arrival upsell nudge job.
 *
 * Runs daily. Finds stays checking in 2 days from now that came through OUR
 * channels, and sends ONE friendly message offering 2–3 of the hotel's enabled
 * extras. Each offer is recorded as an Upsell row (status "offered"), which is
 * also the guard: a booking that already has an offer is never nudged again.
 *
 * OTA-sourced bookings (Booking.com / Airbnb) are NEVER messaged — contacting
 * those guests outside the OTA breaks their terms.
 */
const HotelBooking = require("../models/HotelBooking");
const Upsell = require("../models/Upsell");
const Property = require("../models/Property");
const Workspace = require("../models/Workspace");
const Conversation = require("../models/Conversation");
const Contact = require("../models/Contact");
const { listAvailable, offerUpsell } = require("../services/hotel/upsellService");
const logger = require("../utils/logger");

// Bookings we own the guest relationship for.
const DIRECT_SOURCES = ["whatsapp", "instagram", "tiktok", "direct"];

/** UTC day window [start, end) for "N days from now". */
const dayWindow = (daysFromNow) => {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + daysFromNow);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

async function runUpsellNudges() {
  const { start, end } = dayWindow(2);

  const bookings = await HotelBooking.find({
    checkIn: { $gte: start, $lt: end },
    status: { $in: ["confirmed", "pending"] },
    source: { $in: DIRECT_SOURCES },
    conversationId: { $ne: null },
  }).limit(500);

  logger.info(`[UpsellNudge] ${bookings.length} stays checking in 2 days`);
  let sent = 0;

  for (const booking of bookings) {
    try {
      // Already pitched this stay — never nudge twice.
      const already = await Upsell.countDocuments({ bookingId: booking._id });
      if (already) continue;

      const property = await Property.findById(booking.propertyId);
      const items = listAvailable(property).slice(0, 3);
      if (!items.length) continue;

      const workspace = await Workspace.findById(booking.workspaceId);
      const conversation = await Conversation.findById(booking.conversationId);
      const contact = await Contact.findById(booking.contactId);
      if (!workspace || !conversation || !contact?.igUserId) continue;

      const currency = booking.currency || property?.currency || "USD";
      const first = (booking.guestName || contact.name || "").split(" ")[0];
      const lines = items.map(
        (u) =>
          `• ${u.label}${Number(u.price) > 0 ? ` — ${currency} ${u.price}` : ""}`,
      );
      const text =
        `${first ? `Hi ${first}! ` : "Hi! "}Your stay at ${property?.name || "our place"} is coming up in 2 days 🎉\n\n` +
        `Want to add anything before you arrive?\n${lines.join("\n")}\n\n` +
        "Just reply and I'll sort it out for you.";

      const {
        resolveSendTransport,
      } = require("../services/instagram/automationEngine");
      const transport = await resolveSendTransport(workspace, conversation);
      const result = await transport.send(contact.igUserId, text, {
        conversationId: conversation.metadata?.providerConversationId,
      });

      // Record the offers regardless of send outcome — they double as the
      // "already nudged" guard, and a retry loop that spams a guest is worse
      // than one missed nudge.
      for (const item of items) {
        await offerUpsell({ workspace, booking, key: item.key });
      }

      if (result?.success) sent++;
      else
        logger.warn(
          `[UpsellNudge] send failed booking=${booking.code || booking._id} err=${result?.error || "unknown"}`,
        );
    } catch (err) {
      logger.warn(`[UpsellNudge] booking ${booking._id} failed: ${err.message}`);
    }
  }

  logger.info(`[UpsellNudge] done. sent:${sent}`);
  return { checked: bookings.length, sent };
}

module.exports = { runUpsellNudges };
