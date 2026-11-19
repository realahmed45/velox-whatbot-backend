const mongoose = require("mongoose");

/**
 * Payout — money Botlify sends out automatically (Xendit Payouts API).
 *
 * One payout bundles every eligible ledger entry for one person in one run:
 *  - recipientType "driver"     : earnings from completed Botlify pickups
 *  - recipientType "consultant" : revenue share from the hotels they signed
 *
 * Lifecycle: processing (sent to Xendit) → succeeded | failed.
 * A failed payout releases its entries back to "verified" so the next run
 * retries them once the bank details are fixed.
 */
const payoutSchema = new mongoose.Schema(
  {
    recipientType: { type: String, enum: ["driver", "consultant"], required: true, index: true },
    recipientId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    recipientName: { type: String, default: "" },
    amount: { type: Number, required: true },
    currency: { type: String, default: "IDR" },
    // What the ledger entries added up to before FX (e.g. USD consultant shares).
    sourceAmount: Number,
    sourceCurrency: String,
    fxRate: Number,

    channelCode: { type: String, required: true }, // ID_BCA, ID_GOPAY…
    accountNumber: { type: String, required: true },
    accountHolderName: { type: String, required: true },

    entryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "CommissionEntry" }],
    referenceId: { type: String, required: true, unique: true }, // idempotency key
    providerPayoutId: { type: String, default: null },

    status: {
      type: String,
      enum: ["processing", "succeeded", "failed"],
      default: "processing",
      index: true,
    },
    failureReason: { type: String, default: "" },
    sentAt: Date,
    completedAt: Date,
  },
  { timestamps: true },
);

module.exports = mongoose.models.Payout || mongoose.model("Payout", payoutSchema);
