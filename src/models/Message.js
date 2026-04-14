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
      enum: ["pending", "sent", "delivered", "read", "failed"],
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
  },
  {
    timestamps: true,
  },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ workspaceId: 1, createdAt: -1 });
messageSchema.index({ workspaceId: 1, direction: 1, createdAt: -1 });

module.exports = mongoose.model("Message", messageSchema);
