const mongoose = require("mongoose");

const scheduledPostSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    channelType: {
      type: String,
      enum: ["instagram"],
      default: "instagram",
    },
    imageUrl: {
      type: String,
      required: true, // Cloudinary URL
    },
    caption: {
      type: String,
      default: "",
      maxlength: 2200, // Instagram caption limit
    },
    scheduledTime: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "publishing", "published", "failed", "cancelled"],
      default: "pending",
      index: true,
    },
    publishedAt: Date,
    publishedPostId: String, // Instagram media ID after successful publish
    errorMessage: String,
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

// Index for cron job queries
scheduledPostSchema.index({ status: 1, scheduledTime: 1 });

module.exports = mongoose.model("ScheduledPost", scheduledPostSchema);
