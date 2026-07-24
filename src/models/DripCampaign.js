/**
 * Botlify — Drip Campaign
 * Multi-step DM sequence triggered by events (keyword, tag added, signup, etc.)
 */
const mongoose = require("mongoose");

const stepSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },
    message: { type: String, required: true },
    delayMinutes: { type: Number, default: 0 }, // delay after previous step
    ctaLabel: String,
    ctaUrl: String,
  },
  { _id: false },
);

const dripCampaignSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: String,
    enabled: { type: Boolean, default: true },
    trigger: {
      type: {
        type: String,
        enum: ["keyword", "tag_added", "new_follower", "manual"],
        default: "keyword",
      },
      keyword: String,
      tag: String,
    },
    steps: [stepSchema],
    stats: {
      enrolled: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

const enrollmentSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DripCampaign",
      required: true,
      index: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      required: true,
      index: true,
    },
    currentStep: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 }, // retries for the current step
    nextRunAt: { type: Date, index: true },
    status: {
      type: String,
      enum: ["active", "completed", "cancelled", "failed"],
      default: "active",
      index: true,
    },
    lastError: String,
  },
  { timestamps: true },
);

enrollmentSchema.index({ workspaceId: 1, campaignId: 1, contactId: 1 });

module.exports = {
  DripCampaign: mongoose.model("DripCampaign", dripCampaignSchema),
  DripEnrollment: mongoose.model("DripEnrollment", enrollmentSchema),
};
