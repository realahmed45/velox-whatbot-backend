const mongoose = require("mongoose");

/**
 * Payment — money a guest pays through Botlify (a Xendit payment link).
 *
 *  purpose "stay"     : a bot-closed room booking. Paid to the HOTEL's Xendit
 *                       sub-account; Botlify's commission is split off on
 *                       settlement (split rule).
 *  purpose "transfer" : an airport pickup/drop-off.
 *                       - hotel's own driver  → hotel sub-account, Botlify fee split off
 *                       - Botlify driver      → Botlify master account (our service);
 *                         the driver is paid out after the trip
 *  purpose "extra"    : anything else the hotel bills (deposit, upsell, folio).
 *
 * `receiver` says whose account the money lands in, `platformFee` is Botlify's
 * part, `netToReceiver` what the hotel (or Botlify, for its own service) keeps
 * before Xendit's processing fee.
 */
const paymentSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    purpose: { type: String, enum: ["stay", "transfer", "extra"], required: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "HotelBooking", index: true },
    transferId: { type: mongoose.Schema.Types.ObjectId, ref: "TransferBooking", index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation" },
    description: { type: String, default: "" },

    amount: { type: Number, required: true },
    currency: { type: String, default: "IDR" },
    receiver: { type: String, enum: ["hotel", "platform"], required: true },
    feeRate: { type: Number, default: 0 }, // 0.10 = 10% to Botlify
    platformFee: { type: Number, default: 0 },
    netToReceiver: { type: Number, default: 0 },

    provider: { type: String, default: "xendit" },
    providerAccountId: { type: String, default: null }, // hotel sub-account (for-user-id)
    splitRuleId: { type: String, default: null },
    invoiceId: { type: String, default: null, index: true },
    url: { type: String, default: null },
    expiresAt: Date,

    status: {
      type: String,
      enum: ["pending", "paid", "expired", "failed", "refunded", "cancelled"],
      default: "pending",
      index: true,
    },
    method: { type: String, default: "" }, // QRIS, BCA VA, OVO, card…
    paidAt: Date,
    ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CommissionEntry" },
  },
  { timestamps: true },
);

paymentSchema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.models.Payment || mongoose.model("Payment", paymentSchema);
