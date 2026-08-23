const mongoose = require("mongoose");

/**
 * HotelBooking — a multi-night stay. Two origins:
 *  - Bot-closed (source whatsapp/instagram/tiktok/direct/manual): created by
 *    the AI concierge or the dashboard; carries a 10% platform commission.
 *  - OTA (source booking_com/airbnb/other_ota): mirrored in from Channex
 *    webhooks; ALWAYS 0% commission (that's the product promise).
 *
 * Dates are calendar dates (check-in/check-out day, UTC midnight); nights =
 * checkOut − checkIn. A booking occupies [checkIn, checkOut) — checkout day is
 * free for the next guest.
 */
const hotelBookingSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      required: true,
      index: true,
    },
    roomTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RoomType",
      required: true,
    },
    // Human-friendly reference, e.g. "BK-7F3K2M"
    code: { type: String, unique: true },

    // Guest
    guestName: { type: String, default: "" },
    guestPhone: { type: String, default: "" },
    guestEmail: { type: String, default: "" },
    guestCount: {
      adults: { type: Number, default: 2 },
      children: { type: Number, default: 0 },
    },
    // Link back to the chat that produced the booking (bot-closed only)
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },

    // Stay
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    nights: { type: Number, required: true, min: 1 },
    unitsBooked: { type: Number, default: 1, min: 1 },

    // Money
    nightlyRate: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },

    // Origin
    source: {
      type: String,
      enum: [
        "whatsapp",
        "instagram",
        "tiktok",
        "direct",
        "manual",
        "booking_com",
        "airbnb",
        "other_ota",
      ],
      required: true,
      index: true,
    },
    // OTA linkage (Channex)
    otaReservationId: { type: String, default: null },
    channexBookingId: { type: String, default: null },
    otaRaw: { type: mongoose.Schema.Types.Mixed, select: false },

    status: {
      type: String,
      enum: ["pending", "confirmed", "cancelled", "completed", "no_show"],
      default: "confirmed",
      index: true,
    },

    // Platform commission (bot-closed bookings only; OTA = 0/none)
    commission: {
      rate: { type: Number, default: 0 }, // 0.10 for social/direct
      amount: { type: Number, default: 0 },
      currency: { type: String, default: "USD" },
      ledgerEntryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "CommissionEntry",
      },
    },

    // Payment tracking (informational for v1 — guest pays the hotel directly)
    payment: {
      status: {
        type: String,
        enum: ["unpaid", "deposit", "paid", "refunded", "ota_collected"],
        default: "unpaid",
      },
      method: { type: String, default: "" }, // "cash" | "transfer" | "qris" | ...
      notes: { type: String, default: "" },
    },

    // ── PMS-lite ────────────────────────────────────────────────────────────
    // Which physical unit the guest is in, and the front-desk timestamps.
    unitLabel: { type: String, default: "" },
    checkedInAt: Date,
    checkedOutAt: Date,
    // Folio: extras charged during the stay (upsells, minibar, laundry...).
    // The room charge itself is totalAmount above; this is everything on top.
    folio: [
      {
        label: { type: String, default: "" },
        amount: { type: Number, default: 0 },
        quantity: { type: Number, default: 1 },
        upsellId: { type: mongoose.Schema.Types.ObjectId, ref: "Upsell" },
        addedAt: { type: Date, default: Date.now },
      },
    ],

    specialRequests: { type: String, default: "" },
    notes: { type: String, default: "" },
    cancelledAt: Date,
    cancellationReason: { type: String, default: "" },
  },
  { timestamps: true },
);

// Availability queries: overlapping active bookings per room type.
hotelBookingSchema.index({ roomTypeId: 1, status: 1, checkIn: 1, checkOut: 1 });
hotelBookingSchema.index({ workspaceId: 1, checkIn: -1 });
// Idempotent OTA ingestion: one document per OTA reservation.
hotelBookingSchema.index(
  { otaReservationId: 1 },
  {
    unique: true,
    partialFilterExpression: { otaReservationId: { $type: "string" } },
  },
);

hotelBookingSchema.pre("save", function (next) {
  if (this.isNew && !this.code) {
    this.code =
      "BK-" +
      Math.random()
        .toString(36)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
  }
  next();
});

module.exports = mongoose.model("HotelBooking", hotelBookingSchema);
