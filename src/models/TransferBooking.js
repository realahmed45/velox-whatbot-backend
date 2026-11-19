const mongoose = require("mongoose");

/**
 * TransferBooking — an airport pickup/drop-off arranged by the bot.
 *  - provider "own"   : the hotel's own driver; we just record + notify.
 *  - provider "mozio" : booked through the Mozio partner API on the hotel's
 *                       behalf; Botlify keeps the partner margin.
 */
const transferBookingSchema = new mongoose.Schema(
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
    },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "HotelBooking" },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },

    // Short job reference drivers reply with on WhatsApp, e.g. "T4K9".
    code: { type: String, index: true },

    direction: {
      type: String,
      enum: ["pickup", "dropoff"],
      required: true,
    },
    guestName: { type: String, default: "" },
    guestPhone: { type: String, default: "" },
    passengers: { type: Number, default: 2 },
    flightNumber: { type: String, default: "" },
    pickupAt: { type: Date, required: true },
    airportCode: { type: String, default: "" },

    // "own"      : the hotel's own driver
    // "platform" : dispatched from Botlify's driver pool (hotel has no service)
    // "mozio"    : booked through the Mozio partner API
    provider: {
      type: String,
      enum: ["own", "platform", "mozio"],
      required: true,
    },

    // ── Driver dispatch ─────────────────────────────────────────────────────
    // Who is actually driving, once someone accepts.
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      default: null,
      index: true,
    },
    // Snapshot of what the guest was told. Kept even if the driver record is
    // later edited or removed, so a past trip still reads correctly.
    driverSnapshot: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      vehicleLabel: { type: String, default: "" },
    },
    dispatch: {
      // awaiting_payment : guest hasn't paid the link yet — no driver offered
      // searching : waiting for a driver (offers going out on WhatsApp)
      // assigned  : a driver is on it, and the guest has their details
      // exhausted : every eligible driver was offered and none accepted —
      //             a person must step in (team / hotel alerted)
      state: {
        type: String,
        enum: ["idle", "awaiting_payment", "searching", "assigned", "exhausted"],
        default: "idle",
        index: true,
      },
      // Automatic WhatsApp offers: who was asked, when, and what they said.
      round: { type: Number, default: 0 },
      nextRoundAt: { type: Date, default: null, index: true },
      offers: [
        {
          driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver" },
          at: { type: Date, default: Date.now },
          response: { type: String, enum: ["none", "accepted", "declined", "late"], default: "none" },
        },
      ],
      lastError: { type: String, default: "" },
    },
    // Reminders sent (so each goes out once).
    reminders: {
      driverDayBefore: Date,
      driverSoon: Date,
      guestSoon: Date,
    },
    completedAt: Date,
    completedBy: { type: String, default: "" }, // "driver" | "auto" | "hotel" | "admin"

    // ── Money ───────────────────────────────────────────────────────────────
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
    paymentStatus: {
      type: String,
      enum: ["not_required", "pending", "paid", "refunded"],
      default: "not_required",
    },
    // What the Botlify driver is paid for this trip (platform transfers).
    driverPayout: { type: Number, default: 0 },
    driverEarningEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CommissionEntry" },
    // Mozio linkage
    mozioSearchId: { type: String, default: null },
    mozioReservationId: { type: String, default: null },
    mozioConfirmationNumber: { type: String, default: null },

    price: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    // Partner margin Botlify earns (Mozio commission)
    margin: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["pending", "confirmed", "completed", "cancelled", "failed"],
      default: "pending",
      index: true,
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

transferBookingSchema.index({ workspaceId: 1, pickupAt: -1 });
transferBookingSchema.index({ provider: 1, status: 1, pickupAt: 1 });

transferBookingSchema.pre("save", function (next) {
  if (this.isNew && !this.code) {
    this.code =
      "T" +
      Math.random()
        .toString(36)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
  }
  next();
});

module.exports = mongoose.model("TransferBooking", transferBookingSchema);
