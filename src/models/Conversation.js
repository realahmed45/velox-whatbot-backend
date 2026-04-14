const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      required: true,
    },
    phone: { type: String, required: true },

    status: {
      type: String,
      enum: ["bot_active", "awaiting_human", "human_active", "resolved"],
      default: "bot_active",
      index: true,
    },

    // Which agent is handling (if human_active)
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Current flow execution state
    flowState: {
      flowId: { type: mongoose.Schema.Types.ObjectId, ref: "Flow" },
      currentNodeId: String,
      waitingForInput: { type: Boolean, default: false },
      waitingForVariable: String,
      variables: { type: Map, of: String, default: {} },
      startedAt: Date,
      lastNodeAt: Date,
    },

    // Metadata
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: String,
    unreadCount: { type: Number, default: 0 },
    unreadByAgentCount: { type: Number, default: 0 },

    // Tags
    tags: [String],

    // Internal notes
    internalNotes: [
      {
        content: String,
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    resolvedAt: Date,
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Quick reply context
    lastBotMessageAt: Date,
    botReplyCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  },
);

conversationSchema.index({ workspaceId: 1, lastMessageAt: -1 });
conversationSchema.index({ workspaceId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ workspaceId: 1, phone: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
