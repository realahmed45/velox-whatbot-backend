const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    plan: {
      type: String,
      enum: [
        // current
        "free",
        "ig_starter",
        "ig_pro",
        "wa_starter",
        "wa_pro",
        "bundle_pro",
        "bundle_business",
        // legacy aliases (kept so older docs still load)
        "starter",
        "growth",
        "scale",
        "business",
        "agency",
      ],
      required: true,
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
    },
    status: {
      type: String,
      enum: ["active", "past_due", "suspended", "cancelled", "trialing"],
      default: "active",
    },

    // Pricing in PKR
    amount: { type: Number, required: true },
    currency: { type: String, default: "PKR" },

    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
    cancelledAt: Date,
    trialEndsAt: Date,

    // Payment info
    paymentMethod: {
      type: String,
      enum: ["jazzcash", "easypaisa", "card", "manual"],
    },
    lastPaymentDate: Date,
    lastPaymentAmount: Number,
    lastPaymentStatus: String,
    nextBillingDate: Date,

    // Overage tracking
    overageMessagesCount: { type: Number, default: 0 },
    overageCharges: { type: Number, default: 0 }, // PKR

    // Promo codes
    promoCode: String,
    discountPercent: { type: Number, default: 0 },

    // Invoices reference
    latestInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Subscription", subscriptionSchema);

// ─── Invoice Model ─────────────────────────────────────────
const invoiceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
    },
    invoiceNumber: { type: String, unique: true },
    status: {
      type: String,
      enum: ["draft", "open", "paid", "void", "uncollectible"],
      default: "draft",
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: "PKR" },

    lineItems: [
      {
        description: String,
        quantity: Number,
        unitPrice: Number,
        total: Number,
      },
    ],

    // Payment
    paidAt: Date,
    paymentMethod: String,
    transactionId: String,
    transactionReference: String,

    // PDF
    pdfUrl: String,

    dueDate: Date,
    periodStart: Date,
    periodEnd: Date,
  },
  {
    timestamps: true,
  },
);

invoiceSchema.pre("save", async function (next) {
  if (this.isNew && !this.invoiceNumber) {
    const count = await mongoose.model("Invoice").countDocuments();
    this.invoiceNumber = `VW-${new Date().getFullYear()}-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

mongoose.model("Invoice", invoiceSchema);
