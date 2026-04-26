const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },

    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    type: {
      type: String,
      enum: [
        "text",
        "image",
        "audio",
        "video",
        "document",
        "location",
        "button",
        "interactive",
        "template",
        "sticker",
        "system",
      ],
      default: "text",
    },
    sender: {
      type: String,
      enum: ["customer", "bot", "agent", "system"],
      required: true,
    },

    // Content
    text: String,
    mediaUrl: String,
    mediaCaption: String,
    fileName: String,
    mimeType: String,
    fileSize: Number,

    // Interactive/button message data
    interactiveData: {
      type: String, // 'button' | 'list'
      header: String,
      body: String,
      footer: String,
      buttons: [{ id: String, title: String }],
      sections: mongoose.Schema.Types.Mixed,
    },

    // WhatsApp message ID from provider
    whatsappMessageId: String,
    // Status: sent → delivered → read
    status: {
      type: String,
      enum: ["pending", "sent", "delivered", "read", "failed", "received"],
      default: "pending",
    },
    statusUpdatedAt: Date,

    // For internal/system messages
    isInternalNote: { type: Boolean, default: false },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Flow tracking
    flowId: { type: mongoose.Schema.Types.ObjectId, ref: "Flow" },
    nodeId: String,

    failureReason: String,

    // Channel (whatsapp / instagram) — for multi-channel inbox
    channelType: {
      type: String,
      enum: ["whatsapp", "instagram"],
      default: "whatsapp",
    },

    // Free-form metadata (trigger type, keyword, provider ids, etc.)
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    // AI sentiment analysis on inbound messages
    sentiment: {
      type: String,
      enum: ["positive", "neutral", "negative", "angry"],
    },
    intent: String,
    urgency: { type: String, enum: ["low", "medium", "high"] },
  },
  {
    timestamps: true,
  },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ workspaceId: 1, createdAt: -1 });
messageSchema.index({ workspaceId: 1, direction: 1, createdAt: -1 });
// TTL: auto-delete messages older than 180 days to keep collection bounded.
// Honour an env override if operators want to retain longer.
const MESSAGE_TTL_SECONDS =
  Number(process.env.MESSAGE_TTL_DAYS || 180) * 24 * 60 * 60;
messageSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: MESSAGE_TTL_SECONDS },
);

module.exports = mongoose.model("Message", messageSchema);
