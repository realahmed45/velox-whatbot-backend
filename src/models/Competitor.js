/**
 * Botlify — Competitor Tracking
 * Track public IG accounts; record daily snapshots for benchmarking.
 */
const mongoose = require("mongoose");

const snapshotSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    followers: Number,
    following: Number,
    mediaCount: Number,
    engagementRate: Number,
  },
  { _id: false },
);

const competitorSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    username: { type: String, required: true, trim: true, lowercase: true },
    displayName: String,
    profilePicture: String,
    notes: String,
    snapshots: [snapshotSchema],
    lastSyncedAt: Date,
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

competitorSchema.index({ workspaceId: 1, username: 1 }, { unique: true });

module.exports = mongoose.model("Competitor", competitorSchema);
