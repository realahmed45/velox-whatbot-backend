const mongoose = require("mongoose");

/**
 * Order — a purchase the AI captured from a DM conversation (Smart Orders).
 * Previously the AI emitted an order block that was silently discarded; now we
 * persist it so the merchant actually sees their orders.
 */
const orderItemSchema = new mongoose.Schema(
  {
    name: String,
    qty: { type: Number, default: 1 },
    variant: { type: String, default: "" },
    price: { type: Number, default: 0 },
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
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },
    igUsername: { type: String, default: "" },

    items: [orderItemSchema],
    customerName: { type: String, default: "" },
    customerAddress: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    paymentMethod: { type: String, default: "" },
    subtotal: { type: Number, default: 0 },
    currency: { type: String, default: "" },
    notes: { type: String, default: "" },

    status: {
      type: String,
      enum: ["new", "confirmed", "fulfilled", "cancelled"],
      default: "new",
      index: true,
    },
  },
  { timestamps: true },
);

orderSchema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model("Order", orderSchema);
