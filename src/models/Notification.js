/**
 * Notification — one thing the hotel should know about: a new guest message, a
 * guest who needs a human, a new or cancelled booking, a channel going live or
 * dropping. Shown in the dashboard's bell + pushed live over the socket.
 */
const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    type: {
      type: String,
      enum: [
        "message.new",
        "guest.needs_human",
        "booking.new",
        "booking.cancelled",
        "channel.live",
        "channel.error",
        "whatsapp.connected",
        "whatsapp.disconnected",
        "review.new",
        "transfer.new",
        "transfer.driver_assigned",
        "transfer.needs_driver",
        "transfer.completed",
        "payment.received",
        "payments.live",
        "system",
      ],
      required: true,
    },
    title: { type: String, required: true, maxlength: 160 },
    body: { type: String, default: "", maxlength: 500 },
    link: { type: String, default: "" }, // dashboard route to open, e.g. /dashboard/inbox?c=…
    channel: { type: String, default: "" }, // whatsapp | airbnb | booking_com | expedia | …
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    // Collapses repeats (e.g. several messages in one conversation) into one row.
    dedupeKey: { type: String, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ workspaceId: 1, createdAt: -1 });
notificationSchema.index({ workspaceId: 1, readAt: 1 });
notificationSchema.index({ workspaceId: 1, dedupeKey: 1 });
// Keep 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model("Notification", notificationSchema);
