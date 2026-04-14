const asyncHandler = require("express-async-handler");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Contact = require("../models/Contact");
const QuickReply = require("../models/QuickReply");
const { sendMessage } = require("../services/whatsapp/dispatcher");
const { getIO } = require("../socket");

// @GET /api/inbox — List conversations
const getConversations = asyncHandler(async (req, res) => {
  const { status, search, page = 1, limit = 30 } = req.query;
  const filter = { workspaceId: req.workspace._id };
  if (status && status !== "all") filter.status = status;

  let query = Conversation.find(filter)
    .populate("contactId", "name phone tags")
    .populate("assignedTo", "name avatar")
    .sort({ lastMessageAt: -1 })
    .limit(parseInt(limit))
    .skip((parseInt(page) - 1) * parseInt(limit));

  const [conversations, total] = await Promise.all([
    query.exec(),
    Conversation.countDocuments(filter),
  ]);

  // Search by contact name/phone
  let results = conversations;
  if (search) {
    const s = search.toLowerCase();
    results = conversations.filter((c) => {
      const contact = c.contactId;
      return (
        contact?.phone?.includes(s) ||
        contact?.name?.toLowerCase().includes(s) ||
        c.lastMessagePreview?.toLowerCase().includes(s)
      );
    });
  }

  res.json({
    success: true,
    conversations: results,
    total,
    page: parseInt(page),
  });
});

// @GET /api/inbox/:conversationId/messages — Get messages in a conversation
const getMessages = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const conversation = await Conversation.findOne({
    _id: req.params.conversationId,
    workspaceId: req.workspace._id,
  });
  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  const messages = await Message.find({ conversationId: conversation._id })
    .populate("sentBy", "name avatar")
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .skip((parseInt(page) - 1) * parseInt(limit));

  // Reset unread count when agent views
  await Conversation.findByIdAndUpdate(conversation._id, {
    unreadByAgentCount: 0,
  });

  res.json({ success: true, messages: messages.reverse(), conversation });
});

// @POST /api/inbox/:conversationId/takeover — Agent takes over
const takeOver = asyncHandler(async (req, res) => {
  const conversation = await Conversation.findOne({
    _id: req.params.conversationId,
    workspaceId: req.workspace._id,
  });
  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  conversation.status = "human_active";
  conversation.assignedTo = req.user._id;
  conversation.flowState = null;
  await conversation.save();

  const io = getIO();
  if (io) {
    io.to(`workspace:${req.workspace._id}`).emit("conversation:updated", {
      conversation,
      type: "takeover",
      agentName: req.user.name,
    });
  }

  res.json({
    success: true,
    conversation,
    message: "You are now handling this conversation",
  });
});

// @POST /api/inbox/:conversationId/resolve — Mark as resolved
const resolveConversation = asyncHandler(async (req, res) => {
  const conversation = await Conversation.findOne({
    _id: req.params.conversationId,
    workspaceId: req.workspace._id,
  });
  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  conversation.status = "resolved";
  conversation.resolvedAt = new Date();
  conversation.resolvedBy = req.user._id;
  conversation.flowState = null;
  await conversation.save();

  const io = getIO();
  if (io) {
    io.to(`workspace:${req.workspace._id}`).emit("conversation:updated", {
      conversation,
      type: "resolved",
    });
  }

  res.json({ success: true, conversation });
});

// @POST /api/inbox/:conversationId/send — Agent sends a message
const sendAgentMessage = asyncHandler(async (req, res) => {
  const { text, mediaUrl, mediaType } = req.body;
  if (!text && !mediaUrl) {
    res.status(400);
    throw new Error("Message text or media required");
  }

  const conversation = await Conversation.findOne({
    _id: req.params.conversationId,
    workspaceId: req.workspace._id,
  }).populate("contactId", "phone");
  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  const workspace = req.workspace;
  const phone = conversation.phone;

  // Send via WhatsApp
  const payload = mediaUrl
    ? { type: mediaType || "image", imageUrl: mediaUrl }
    : { type: "text", text };

  const result = await sendMessage(workspace, phone, payload);

  const message = await Message.create({
    workspaceId: workspace._id,
    conversationId: conversation._id,
    contactId: conversation.contactId,
    direction: "outbound",
    type: payload.type,
    sender: "agent",
    text,
    mediaUrl,
    status: result.success ? "sent" : "failed",
    whatsappMessageId: result.messageId,
    sentBy: req.user._id,
    failureReason: result.success ? undefined : result.error,
  });

  conversation.lastMessageAt = new Date();
  conversation.lastMessagePreview = text?.slice(0, 60) || "[Media]";
  await conversation.save();

  const io = getIO();
  if (io) {
    io.to(`workspace:${workspace._id}`).emit("message:new", {
      message,
      conversation,
    });
  }

  res.status(201).json({ success: true, message });
});

// @POST /api/inbox/:conversationId/notes — Add internal note
const addNote = asyncHandler(async (req, res) => {
  const { content } = req.body;
  if (!content) {
    res.status(400);
    throw new Error("Note content required");
  }

  const conversation = await Conversation.findOne({
    _id: req.params.conversationId,
    workspaceId: req.workspace._id,
  });
  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }

  conversation.internalNotes.push({ content, addedBy: req.user._id });
  await conversation.save();

  // Also save as internal message
  const message = await Message.create({
    workspaceId: req.workspace._id,
    conversationId: conversation._id,
    direction: "outbound",
    type: "system",
    sender: "agent",
    text: content,
    isInternalNote: true,
    sentBy: req.user._id,
    status: "sent",
  });

  res.status(201).json({ success: true, message });
});

// @POST /api/inbox/:conversationId/assign — Assign to agent
const assignConversation = asyncHandler(async (req, res) => {
  const { agentId } = req.body;
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.conversationId, workspaceId: req.workspace._id },
    { assignedTo: agentId },
    { new: true },
  ).populate("assignedTo", "name avatar");
  if (!conversation) {
    res.status(404);
    throw new Error("Conversation not found");
  }
  res.json({ success: true, conversation });
});

// @GET /api/inbox/quick-replies — Get quick replies
const getQuickReplies = asyncHandler(async (req, res) => {
  const replies = await QuickReply.find({ workspaceId: req.workspace._id });
  res.json({ success: true, replies });
});

// @POST /api/inbox/quick-replies — Create quick reply
const createQuickReply = asyncHandler(async (req, res) => {
  const { shortcut, message } = req.body;
  if (!shortcut || !message) {
    res.status(400);
    throw new Error("Shortcut and message required");
  }
  const reply = await QuickReply.create({
    workspaceId: req.workspace._id,
    shortcut,
    message,
    createdBy: req.user._id,
  });
  res.status(201).json({ success: true, reply });
});

// @DELETE /api/inbox/quick-replies/:id
const deleteQuickReply = asyncHandler(async (req, res) => {
  await QuickReply.findOneAndDelete({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  res.json({ success: true, message: "Quick reply deleted" });
});

module.exports = {
  getConversations,
  getMessages,
  takeOver,
  resolveConversation,
  sendAgentMessage,
  addNote,
  assignConversation,
  getQuickReplies,
  createQuickReply,
  deleteQuickReply,
};
