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
    phone: { type: String }, // optional — IG conversations use contactId.igUserId
    channelType: {
      type: String,
      enum: ["whatsapp", "instagram", "messenger"],
      default: "instagram",
      index: true,
    },

    status: {
      type: String,
      enum: [
        "open",
        "bot_active",
        "awaiting_human",
        "human_active",
        "resolved",
        "closed",
      ],
      default: "bot_active",
      index: true,
    },

    // Per-conversation bot toggle. When false, automations STOP for this conversation
    // until agent turns bot back on (or after long silence, depending on settings).
    botEnabled: { type: Boolean, default: true },
    botPausedAt: Date,
    botPausedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    lastAgentReplyAt: Date,

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

    // Trigger / AI metadata (flexible bag used by automation engine)
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

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
conversationSchema.index({ workspaceId: 1, channelType: 1, contactId: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
