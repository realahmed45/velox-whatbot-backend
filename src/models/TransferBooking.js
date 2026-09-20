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
      // idle      : nothing to do (own driver, or manual)
      // searching : an offer is out, waiting on a reply
      // assigned  : a driver accepted
      // exhausted : every candidate declined or timed out — needs a human
      state: {
        type: String,
        enum: ["idle", "searching", "assigned", "exhausted"],
        default: "idle",
        index: true,
      },
      // Every driver we asked, in order, with what happened. This is the audit
      // trail when a hotel asks why a particular driver got the job.
      offers: [
        {
          driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver" },
          offeredAt: { type: Date },
          expiresAt: { type: Date },
          respondedAt: { type: Date },
          outcome: {
            type: String,
            enum: ["pending", "accepted", "declined", "timeout"],
            default: "pending",
          },
        },
      ],
      lastError: { type: String, default: "" },
    },
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
// The sweep that times out unanswered offers reads exactly this.
transferBookingSchema.index({ "dispatch.state": 1, "dispatch.offers.expiresAt": 1 });

module.exports = mongoose.model("TransferBooking", transferBookingSchema);
