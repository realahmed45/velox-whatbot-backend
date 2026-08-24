/**
 * bookingService.js — create/cancel multi-night stays.
 *
 * Bot-closed bookings (whatsapp/instagram/tiktok/direct/manual) carry the 10%
 * platform commission and write to the commission ledger. OTA bookings
 * (Booking.com/Airbnb mirrored in via Channex) are ALWAYS 0% and idempotent by
 * otaReservationId.
 *
 * Mirrors the appointment saveBooking pattern: validate availability first,
 * persist, then best-effort side effects (ledger, Channex sync, socket, email,
 * outbound webhooks) that never fail the booking itself.
 */
const logger = require("../../utils/logger");
const HotelBooking = require("../../models/HotelBooking");
const RoomType = require("../../models/RoomType");
const Property = require("../../models/Property");
const { getAvailableUnits, toDay } = require("./availability");
const { SOCIAL_BOOKING_COMMISSION_RATE } = require("../../config/plans");

const BOT_SOURCES = ["whatsapp", "instagram", "tiktok", "direct"];
const OTA_SOURCES = ["booking_com", "airbnb", "other_ota"];

/** Short, human-quotable booking reference (matches the model's pre-save hook). */
function generateBookingCode() {
  return (
    "BK-" +
    Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6)
  );
}

/** Human label for a stay, e.g. "Fri, 12 Sep → Mon, 15 Sep (3 nights)". */
function stayLabel(checkIn, checkOut, nights) {
  const fmt = (d) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(d);
  return `${fmt(checkIn)} → ${fmt(checkOut)} (${nights} night${nights > 1 ? "s" : ""})`;
}

/**
 * Create a booking. Source decides commission:
 *   bot/direct → 10% ledger entry; manual → no commission (hotel's own desk
 *   booking, we just track it); OTA → use ingestOtaBooking instead.
 *
 * @returns {Promise<{ok, booking?, reason?, confirmationText?}>}
 */
async function createBooking({
  workspace,
  propertyId,
  roomTypeId,
  checkIn,
  checkOut,
  guestName = "",
  guestPhone = "",
  guestEmail = "",
  adults = 2,
  children = 0,
  unitsBooked = 1,
  source,
  contact = null,
  conversation = null,
  specialRequests = "",
  nightlyRate = null,
}) {
  if (![...BOT_SOURCES, "manual"].includes(source)) {
    return { ok: false, reason: "invalid_source" };
  }
  const roomType = await RoomType.findOne({
    _id: roomTypeId,
    workspaceId: workspace._id,
    active: true,
  });
  if (!roomType) return { ok: false, reason: "room_type_not_found" };
  const property = await Property.findOne({
    _id: propertyId || roomType.propertyId,
    workspaceId: workspace._id,
  });
  if (!property) return { ok: false, reason: "property_not_found" };

  // Re-validate availability — the model may offer a stale/hallucinated range.
  const check = await getAvailableUnits(roomType, checkIn, checkOut);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (check.available < unitsBooked) {
    return { ok: false, reason: "no_availability" };
  }

  const rate = nightlyRate ?? roomType.baseRate ?? 0;
  const total = Math.round(rate * check.nights * unitsBooked * 100) / 100;
  const currency = roomType.currency || property.currency || "USD";
  const isCommissionable = BOT_SOURCES.includes(source) && total > 0;

  const booking = await HotelBooking.create({
    workspaceId: workspace._id,
    propertyId: property._id,
    roomTypeId: roomType._id,
    guestName: guestName || contact?.name || "",
    guestPhone: guestPhone || contact?.phone || "",
    guestEmail: guestEmail || contact?.email || "",
    guestCount: { adults, children },
    contactId: contact?._id,
    conversationId: conversation?._id,
    checkIn: check.from,
    checkOut: check.to,
    nights: check.nights,
    unitsBooked,
    nightlyRate: rate,
    totalAmount: total,
    currency,
    source,
    status: "confirmed",
    specialRequests,
    commission: isCommissionable
      ? {
          rate: SOCIAL_BOOKING_COMMISSION_RATE,
          amount:
            Math.round(total * SOCIAL_BOOKING_COMMISSION_RATE * 100) / 100,
          currency,
        }
      : { rate: 0, amount: 0, currency },
  });

  // ── Side effects (never fail the booking) ────────────────────────────────
  if (isCommissionable) {
    try {
      const { recordRevenue } = require("../commissionService");
      const entry = await recordRevenue({
        workspaceId: workspace._id,
        type: "booking_commission",
        amount: booking.commission.amount,
        currency,
        rate: SOCIAL_BOOKING_COMMISSION_RATE,
        bookingId: booking._id,
        reference: booking.code,
      });
      if (entry) {
        booking.commission.ledgerEntryId = entry._id;
        await booking.save();
      }
    } catch (e) {
      logger.warn("[hotelBooking] ledger failed", { err: e.message });
    }
  }

  await afterBookingChange(property, roomType, booking, "created");

  const label = stayLabel(booking.checkIn, booking.checkOut, booking.nights);
  const confirmationText =
    `You're booked! ✅ ${roomType.name} — ${label}` +
    (total > 0 ? `\n💰 Total: ${currency} ${total}` : "") +
    `\n🔖 Booking code: ${booking.code}` +
    (property.address ? `\n📍 ${property.name}, ${property.address}` : "");

  logger.info(
    `[hotelBooking] created ws=${workspace._id} code=${booking.code} src=${source} ${label}`,
  );
  return { ok: true, booking, confirmationText };
}

/**
 * Idempotently mirror an OTA reservation from Channex into our bookings.
 * ALWAYS 0% commission. Re-delivery of the same reservation updates in place.
 */
async function ingestOtaBooking({
  property,
  roomType,
  otaReservationId,
  channexBookingId = null,
  source = "other_ota",
  status = "confirmed",
  checkIn,
  checkOut,
  guestName = "",
  guestPhone = "",
  guestEmail = "",
  adults = 2,
  children = 0,
  totalAmount = 0,
  currency = null,
  raw = null,
}) {
  if (!otaReservationId) return { ok: false, reason: "missing_reservation_id" };
  const from = toDay(checkIn);
  const to = toDay(checkOut);
  if (!from || !to || to <= from) return { ok: false, reason: "invalid_dates" };
  const nights = Math.round((to - from) / (24 * 3600 * 1000));

  const update = {
    workspaceId: property.workspaceId,
    propertyId: property._id,
    roomTypeId: roomType._id,
    guestName,
    guestPhone,
    guestEmail,
    guestCount: { adults, children },
    checkIn: from,
    checkOut: to,
    nights,
    totalAmount,
    currency: currency || property.currency || "USD",
    source: OTA_SOURCES.includes(source) ? source : "other_ota",
    status,
    channexBookingId,
    otaRaw: raw,
    "payment.status": "ota_collected",
    "commission.rate": 0,
    "commission.amount": 0,
  };

  // findOneAndUpdate bypasses the pre("save") hook that generates `code`, so an
  // upserted OTA booking would be created with code:null — and the second one
  // would then collide on the unique index. Generate it here for inserts.
  const booking = await HotelBooking.findOneAndUpdate(
    { otaReservationId },
    {
      $set: update,
      $setOnInsert: { otaReservationId, code: generateBookingCode() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await afterBookingChange(property, roomType, booking, "ota_synced");
  logger.info(
    `[hotelBooking] OTA ingest ws=${property.workspaceId} res=${otaReservationId} src=${source} status=${status}`,
  );
  return { ok: true, booking };
}

/** Cancel a booking; void its ledger entry; resync availability. */
async function cancelBooking(bookingId, { reason = "", workspaceId } = {}) {
  const q = { _id: bookingId };
  if (workspaceId) q.workspaceId = workspaceId;
  const booking = await HotelBooking.findOne(q);
  if (!booking) return { ok: false, reason: "not_found" };
  if (booking.status === "cancelled") return { ok: true, booking };

  booking.status = "cancelled";
  booking.cancelledAt = new Date();
  booking.cancellationReason = reason;
  await booking.save();

  if (booking.commission?.ledgerEntryId) {
    try {
      const { voidRevenueEntry } = require("../commissionService");
      await voidRevenueEntry(
        booking.commission.ledgerEntryId,
        `booking ${booking.code} cancelled`,
      );
    } catch (e) {
      logger.warn("[hotelBooking] ledger void failed", { err: e.message });
    }
  }

  const property = await Property.findById(booking.propertyId);
  const roomType = await RoomType.findById(booking.roomTypeId);
  if (property && roomType) {
    await afterBookingChange(property, roomType, booking, "cancelled");
  }
  return { ok: true, booking };
}

/** Shared side effects: Channex availability push, socket, email, webhooks. */
async function afterBookingChange(property, roomType, booking, event) {
  // Push fresh availability to the OTAs so social bookings block OTA calendars
  // (and vice versa the OTAs already decremented on their side). Which channel
  // manager that means is the property's business, not ours — the router picks
  // it and hands back null when there's nothing connected.
  //
  // OTA-originated events don't need a push for their own range — the provider
  // already knows. Push anyway is harmless but wasteful; skip it.
  if (event !== "ota_synced") {
    try {
      const { getProvider, providerRoomId } = require("../channels");
      const channel = getProvider(property);
      if (channel && providerRoomId(property, roomType)) {
        await channel.pushAvailabilityRange(
          property,
          roomType,
          booking.checkIn,
          booking.checkOut,
        );
      }
    } catch (e) {
      logger.warn("[hotelBooking] availability push failed", {
        provider: property.channel?.provider,
        err: e.message,
      });
    }
  }

  try {
    const { getIO } = require("../../socket");
    getIO()
      ?.to(`workspace:${property.workspaceId}`)
      .emit("hotelBooking:changed", {
        bookingId: String(booking._id),
        code: booking.code,
        status: booking.status,
        source: booking.source,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guestName: booking.guestName,
        event,
      });
  } catch {
    /* socket not ready */
  }

  try {
    const { dispatchEvent } = require("../webhookDispatcher");
    dispatchEvent(property.workspaceId, `hotel_booking.${event}`, {
      bookingId: String(booking._id),
      code: booking.code,
      status: booking.status,
      source: booking.source,
      roomType: roomType.name,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      totalAmount: booking.totalAmount,
      currency: booking.currency,
    }).catch(() => {});
  } catch {
    /* dispatcher not ready */
  }

  // Email the hotel on new bookings (not on every OTA re-sync of the same one).
  if (event === "created") {
    try {
      await notifyHotel(property, roomType, booking);
    } catch (e) {
      logger.warn("[hotelBooking] notify email failed", { err: e.message });
    }
  }
}

async function notifyHotel(property, roomType, booking) {
  const Workspace = require("../../models/Workspace");
  const ws = await Workspace.findById(property.workspaceId)
    .select("owner")
    .populate("owner", "email");
  const to = property.email || ws?.owner?.email;
  if (!to) return;
  const { sendEmail } = require("../emailService");
  const base = process.env.CLIENT_URL || "https://botlify.site";
  const label = stayLabel(booking.checkIn, booking.checkOut, booking.nights);
  await sendEmail({
    to,
    subject: `🏨 New booking ${booking.code}: ${booking.guestName || "Guest"} — ${label}`,
    text:
      `New booking via ${booking.source}.\n\n` +
      `Room: ${roomType.name}\n` +
      `Stay: ${label}\n` +
      `Guest: ${booking.guestName || "—"}${booking.guestPhone ? ` (${booking.guestPhone})` : ""}\n` +
      `Total: ${booking.currency} ${booking.totalAmount}\n` +
      (booking.specialRequests ? `Requests: ${booking.specialRequests}\n` : "") +
      `\nManage: ${base}/dashboard/bookings`,
    html:
      `<h2>🏨 New booking ${booking.code}</h2>` +
      `<table cellpadding="6" style="border-collapse:collapse">` +
      `<tr><td><b>Room</b></td><td>${roomType.name}</td></tr>` +
      `<tr><td><b>Stay</b></td><td>${label}</td></tr>` +
      `<tr><td><b>Guest</b></td><td>${booking.guestName || "—"}${booking.guestPhone ? ` (${booking.guestPhone})` : ""}</td></tr>` +
      `<tr><td><b>Source</b></td><td>${booking.source}</td></tr>` +
      `<tr><td><b>Total</b></td><td>${booking.currency} ${booking.totalAmount}</td></tr>` +
      `</table>` +
      `<p><a href="${base}/dashboard/bookings">Manage bookings →</a></p>`,
  });
}

module.exports = {
  createBooking,
  ingestOtaBooking,
  cancelBooking,
  stayLabel,
  BOT_SOURCES,
  OTA_SOURCES,
};
