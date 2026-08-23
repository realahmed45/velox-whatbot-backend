const mongoose = require("mongoose");

/**
 * Upsell — an extra the hotel sells on top of a stay (early check-in, upgrade,
 * breakfast, tour, late checkout...). Two halves:
 *   - the CATALOG lives on the Property (what's offered, at what price)
 *   - this model records one OFFER made to one guest and what came of it.
 *
 * Accepted upsells are hotel revenue and count toward our booking commission
 * the same way a bot-closed booking does.
 */
const upsellSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "HotelBooking",
      required: true,
      index: true,
    },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
    // Matches an entry in Property.upsells[] by key.
    key: { type: String, required: true },
    label: { type: String, required: true },
    price: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    quantity: { type: Number, default: 1 },
    status: {
      type: String,
      enum: ["offered", "accepted", "declined", "cancelled"],
      default: "offered",
      index: true,
    },
    offeredAt: { type: Date, default: Date.now },
    respondedAt: Date,
    // Commission ledger entry created when accepted (10%, same as bookings).
    ledgerEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommissionEntry",
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

upsellSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Upsell", upsellSchema);
