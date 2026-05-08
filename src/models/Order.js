const mongoose = require("mongoose");

/**
 * Smart Orders — captured by AI from a chat conversation.
 * No payment processing. Merchant fulfills offline.
 *
 * Lifecycle:
 *   new → confirmed → shipped → delivered (or cancelled at any point)
 *
 * Each status change can fire a templated message back to the customer
 * via the existing channel dispatcher (handled in controller).
 */
const orderItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    qty: { type: Number, default: 1, min: 1 },
    variant: { type: String, default: "" },
    price: { type: Number, default: 0 }, // unit price as parsed by AI; may be 0 if unknown
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      index: true,
    },
    channel: {
      type: String,
      enum: ["whatsapp", "instagram", "messenger", "manual"],
      default: "whatsapp",
    },

    // Items + totals
    items: { type: [orderItemSchema], default: [] },
    itemsText: { type: String, default: "" }, // free-form fallback if structured parse fails
    subtotal: { type: Number, default: 0 },
    currency: { type: String, default: "PKR" },

    // Customer
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    customerAddress: { type: String, default: "" },
    customerNotes: { type: String, default: "" },

    paymentMethod: { type: String, default: "" }, // free text: "COD" / "JazzCash" / "Bank transfer"

    status: {
      type: String,
      enum: ["new", "confirmed", "shipped", "delivered", "cancelled"],
      default: "new",
      index: true,
    },

    // Free-form notes by the merchant
    merchantNotes: { type: String, default: "" },

    // Source — how was this order captured
    source: {
      type: String,
      enum: ["ai", "manual"],
      default: "ai",
    },

    // Timestamps for each status change (for analytics + digest)
    confirmedAt: Date,
    shippedAt: Date,
    deliveredAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true },
);

orderSchema.index({ workspaceId: 1, createdAt: -1 });
orderSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);
