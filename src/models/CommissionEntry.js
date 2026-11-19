const mongoose = require("mongoose");

/**
 * CommissionEntry — the money ledger. One row per revenue/payout event:
 *
 *  kind "platform_revenue": money Botlify earned from a hotel.
 *    revenueType: "saas" (subscription) | "booking_commission" (10% on
 *    bot-closed bookings) | "transfer_margin" (Mozio share).
 *
 *  kind "consultant_share": what a consultant earned from one revenue event
 *    (20% of the linked platform_revenue row).
 *
 *  kind "driver_earning": what a Botlify driver earned for one completed
 *    pickup (revenueType "driver_fare").
 *
 * Lifecycle for shares/earnings: accrued → verified (eligible: the money was
 * actually collected and the hold period passed — set automatically by
 * payoutService, or by an admin) → processing (inside a Xendit payout) → paid.
 * `collectedAt` on a platform_revenue row means Botlify actually received it
 * (Creem charge, Xendit split settled, or an invoice the hotel paid).
 */
const commissionEntrySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: ["platform_revenue", "consultant_share", "driver_earning"],
      required: true,
      index: true,
    },
    revenueType: {
      type: String,
      enum: ["saas", "booking_commission", "transfer_margin", "driver_fare"],
      required: true,
    },
    amount: { type: Number, required: true }, // USD-equivalent
    currency: { type: String, default: "USD" },
    // Original amount/currency when the source wasn't USD (e.g. IDR bookings)
    sourceAmount: Number,
    sourceCurrency: String,
    rate: Number, // commission/share rate applied (0.10, 0.20, …)

    // Linkage
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "HotelBooking" },
    transferId: { type: mongoose.Schema.Types.ObjectId, ref: "TransferBooking" },
    consultantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Consultant",
      index: true,
    },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", index: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment" },
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "Payout" },
    // platform_revenue only: when Botlify actually received the money.
    collectedAt: { type: Date, default: null },
    // For consultant_share rows: the platform_revenue row it derives from.
    parentEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommissionEntry",
    },
    reference: { type: String, default: "" }, // free-form: "creem:sub_x", booking code…

    // Billing period bucket "YYYY-MM" for monthly invoicing/payout runs.
    period: { type: String, index: true },

    status: {
      type: String,
      enum: ["accrued", "verified", "invoiced", "processing", "paid", "void"],
      default: "accrued",
      index: true,
    },
    verifiedAt: Date,
    verifiedBy: { type: String, default: "" }, // admin email
    paidAt: Date,
    paidBy: { type: String, default: "" },
    payoutReference: { type: String, default: "" }, // bank txn ref
    voidReason: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

commissionEntrySchema.index({ consultantId: 1, status: 1, period: 1 });
commissionEntrySchema.index({ workspaceId: 1, kind: 1, period: 1 });

module.exports = mongoose.model("CommissionEntry", commissionEntrySchema);
