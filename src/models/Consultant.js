const mongoose = require("mongoose");

/**
 * Consultant — a door-to-door marketer who signs hotels up to Botlify.
 * Earns CONSULTANT_REVENUE_SHARE_RATE (20%) of everything Botlify earns from
 * each hotel they signed, for CONSULTANT_SHARE_MONTHS (12) after attribution.
 * All payouts are MANUAL (bank transfer) — the system only tracks the ledger.
 * Admin must approve a consultant before their code attributes new hotels.
 */
const consultantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // Referral code hotels enter at onboarding, e.g. "CON-4X9TQ2"
    code: { type: String, unique: true, uppercase: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "approved", "suspended"],
      default: "pending",
      index: true,
    },
    // Public profile
    fullName: { type: String, default: "" },
    phone: { type: String, default: "" },
    country: { type: String, default: "ID" },
    city: { type: String, default: "" },
    // Manual payout details (bank transfer)
    payout: {
      bankName: { type: String, default: "" },
      accountName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      notes: { type: String, default: "" },
    },
    // Denormalized totals (kept in sync by commissionService)
    totals: {
      hotelsSigned: { type: Number, default: 0 },
      accrued: { type: Number, default: 0 }, // lifetime accrued (USD)
      paid: { type: Number, default: 0 }, // lifetime paid out (USD)
    },
    approvedAt: Date,
    approvedBy: { type: String, default: "" }, // admin email
    suspendedReason: { type: String, default: "" },
  },
  { timestamps: true },
);

consultantSchema.pre("save", function (next) {
  if (this.isNew && !this.code) {
    this.code =
      "CON-" +
      Math.random()
        .toString(36)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
  }
  next();
});

module.exports = mongoose.model("Consultant", consultantSchema);
