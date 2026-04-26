/**
 * Botlify — Giveaway / Contest
 * Runs on a post or reel. Users comment to enter. Winner picked at end.
 */
const mongoose = require("mongoose");

const giveawaySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    prize: String,
    postId: { type: String, required: true, index: true }, // IG media id
    postUrl: String,
    entryKeyword: String, // optional — must include this word in comment
    requireFollow: { type: Boolean, default: false },
    requireTag: { type: Boolean, default: false },
    startsAt: { type: Date, default: Date.now },
    endsAt: { type: Date, required: true, index: true },
    maxWinners: { type: Number, default: 1 },
    winnerDmMessage: {
      type: String,
      default:
        "🎉 Congrats {name}! You won our giveaway! Reply here to claim your prize.",
    },
    participants: [
      {
        igUserId: String,
        igUsername: String,
        commentId: String,
        commentText: String,
        commentedAt: { type: Date, default: Date.now },
      },
    ],
    winners: [
      {
        igUserId: String,
        igUsername: String,
        pickedAt: { type: Date, default: Date.now },
        notified: { type: Boolean, default: false },
      },
    ],
    status: {
      type: String,
      enum: ["scheduled", "active", "picking", "completed", "cancelled"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true },
);

giveawaySchema.index({ workspaceId: 1, status: 1, endsAt: 1 });

module.exports = mongoose.model("Giveaway", giveawaySchema);
