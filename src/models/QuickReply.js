const mongoose = require("mongoose");

const quickReplySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    shortcut: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);

quickReplySchema.index({ workspaceId: 1, shortcut: 1 }, { unique: true });

module.exports = mongoose.model("QuickReply", quickReplySchema);
