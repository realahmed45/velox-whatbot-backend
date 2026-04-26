/**
 * Botlify — AI Controller
 * Exposes OpenAI-powered utilities: captions, reply suggestions, sentiment.
 */
const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const ai = require("../services/ai/openaiService");

// POST /api/ai/caption { topic, tone?, count?, language? }
exports.generateCaption = asyncHandler(async (req, res) => {
  const { topic, tone, count, language } = req.body;
  if (!topic || !topic.trim()) {
    return res.status(400).json({ message: "topic is required" });
  }
  const ws = req.workspace;
  const result = await ai.generateCaption({
    topic: topic.trim(),
    brandVoice: ws?.aiBot?.personality || "",
    tone: tone || "casual",
    count: Math.min(5, Math.max(1, parseInt(count) || 3)),
    language: language || "en",
  });
  res.json({ success: true, ...result });
});

// POST /api/ai/suggest-replies { conversationId }
exports.suggestReplies = asyncHandler(async (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) {
    return res.status(400).json({ message: "conversationId is required" });
  }
  const conv = await Conversation.findOne({
    _id: conversationId,
    workspaceId: req.workspace._id,
  }).populate("contactId");
  if (!conv) return res.status(404).json({ message: "Conversation not found" });

  const msgs = await Message.find({ conversationId })
    .sort({ createdAt: 1 })
    .limit(20)
    .lean();

  const lastInbound = [...msgs]
    .reverse()
    .find((m) => m.direction === "inbound");
  if (!lastInbound) {
    return res.json({ success: true, suggestions: [] });
  }

  const history = msgs.map((m) => ({
    role: m.direction === "inbound" ? "user" : "assistant",
    content: m.text || "",
  }));

  const result = await ai.suggestReplies({
    workspace: req.workspace,
    history,
    userMessage: lastInbound.text || "",
    contact: conv.contactId,
  });
  res.json({ success: true, ...result });
});

// POST /api/ai/sentiment { text }
exports.analyzeSentiment = asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ message: "text is required" });
  const result = await ai.analyzeSentiment(text);
  res.json({ success: true, ...result });
});

// POST /api/ai/hashtags { topic, language?, count? }
exports.researchHashtags = asyncHandler(async (req, res) => {
  const { topic, language, count } = req.body;
  if (!topic || !topic.trim()) {
    return res.status(400).json({ message: "topic is required" });
  }
  const result = await ai.researchHashtags({
    topic: topic.trim(),
    language: language || "en",
    count: Math.min(50, Math.max(10, parseInt(count) || 30)),
  });
  res.json({ success: true, ...result });
});
