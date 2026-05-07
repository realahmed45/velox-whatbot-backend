const mongoose = require("mongoose");

const broadcastCampaignSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    // Channel the campaign belongs to. WhatsApp is the default for legacy
    // campaigns created before per-channel separation.
    channel: {
      type: String,
      enum: ["whatsapp", "instagram"],
      default: "whatsapp",
      index: true,
    },
    name: { type: String, required: true },
    message: { type: String, required: true },
    mediaUrl: String,
    mediaType: { type: String, enum: ["image", "document", null] },

    // Targeting
    targetSegment: {
      type: {
        type: String,
        enum: ["all", "tag", "date_range", "custom"],
        default: "all",
      },
      tags: [String],
      dateField: { type: String, enum: ["firstSeenAt", "lastSeenAt"] },
      dateFrom: Date,
      dateTo: Date,
    },

    // Scheduling
    scheduledAt: Date,
    isScheduled: { type: Boolean, default: false },
    sentAt: Date,

    status: {
      type: String,
      enum: ["draft", "scheduled", "sending", "sent", "cancelled", "failed"],
      default: "draft",
    },

    // Stats
    stats: {
      totalTargeted: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      read: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },

    // Credits used
    creditsUsed: { type: Number, default: 0 },
    costPKR: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("BroadcastCampaign", broadcastCampaignSchema);
