const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
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
  toggleBot,
  updateConversationTags,
} = require("../controllers/inboxController");

router.use(protect);
router.use(requireWorkspace);

router.get("/", getConversations);
router.get("/quick-replies", getQuickReplies);
router.post("/quick-replies", createQuickReply);
router.delete("/quick-replies/:id", deleteQuickReply);

router.get("/:conversationId/messages", getMessages);
router.post("/:conversationId/takeover", takeOver);
router.post("/:conversationId/resolve", resolveConversation);
router.post("/:conversationId/send", sendAgentMessage);
router.post("/:conversationId/notes", addNote);
router.patch("/:conversationId/assign", assignConversation);
router.patch("/:conversationId/bot", toggleBot);
router.patch("/:conversationId/tags", updateConversationTags);

module.exports = router;
