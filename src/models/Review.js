const mongoose = require("mongoose");

/**
 * Review — a guest review (from an OTA via Channex, or requested directly by
 * us after checkout). The reputation engine drafts a reply the owner approves.
 */
const reviewSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "Property" },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "HotelBooking" },
    source: {
      type: String,
      enum: ["booking_com", "airbnb", "google", "direct", "other"],
      default: "direct",
    },
    externalId: { type: String, default: null },
    guestName: { type: String, default: "" },
    rating: { type: Number, min: 1, max: 10 },
    // Normalized 1–5 for display regardless of the source's scale.
    stars: { type: Number, min: 1, max: 5 },
    title: { type: String, default: "" },
    text: { type: String, default: "" },
    language: { type: String, default: "" },
    reviewedAt: Date,
    // Reply lifecycle: AI drafts → owner approves → posted/sent.
    reply: {
      draft: { type: String, default: "" },
      status: {
        type: String,
        enum: ["none", "drafted", "approved", "posted", "skipped"],
        default: "none",
      },
      approvedAt: Date,
      postedAt: Date,
    },
    // Themes the AI extracted, for the "recurring complaints" summary.
    themes: [{ type: String }],
    sentiment: {
      type: String,
      enum: ["positive", "neutral", "negative"],
      default: "neutral",
      index: true,
    },
  },
  { timestamps: true },
);

reviewSchema.index(
  { externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: "string" } } },
);
reviewSchema.index({ workspaceId: 1, reviewedAt: -1 });

module.exports = mongoose.model("Review", reviewSchema);
