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
    // Post kind — regular feed image or Story (C6)
    postType: {
      type: String,
      enum: ["image", "story"],
      default: "image",
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
    submittedAt: Date, // when we handed it to the provider (queued)
    publishedPostId: String, // Instagram media ID after successful publish
    errorMessage: String,

    // Recurring posts — cron-style repeats
    recurring: {
      enabled: { type: Boolean, default: false },
      // frequency: daily | weekly | monthly
      frequency: {
        type: String,
        enum: ["daily", "weekly", "monthly"],
        default: "weekly",
      },
      // days of week for weekly (0=Sun..6=Sat)
      daysOfWeek: [{ type: Number, min: 0, max: 6 }],
      // hour + minute to repeat at
      hour: { type: Number, default: 9 },
      minute: { type: Number, default: 0 },
      // stop after N occurrences (optional)
      maxOccurrences: Number,
      occurrences: { type: Number, default: 0 },
      // parent recurring post id (for child instances)
      parentId: { type: mongoose.Schema.Types.ObjectId, ref: "ScheduledPost" },
    },

    // Bulk upload batch id (to group a CSV import)
    bulkBatchId: String,

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
