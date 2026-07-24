const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const { verifyTurnstile } = require("../middleware/turnstile");
const { requireFeature } = require("../middleware/planGate");
const { FEATURES } = require("../config/plans");
const c = require("../controllers/workspaceController");
const multer = require("multer");

// In-memory upload for knowledge documents (PDF / Word / text / images). 25 MB cap.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      [
        "application/pdf",
        "text/plain",
        "text/markdown",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/octet-stream",
      ].includes(file.mimetype) ||
      /^image\//i.test(file.mimetype) ||
      /\.(pdf|txt|md|doc|docx|png|jpe?g|gif|webp|bmp|heic)$/i.test(
        file.originalname,
      );
    cb(
      ok ? null : new Error("Upload a PDF, Word doc, text file, or image"),
      ok,
    );
  },
});

// ─── Public invite endpoints (no auth) ─────────────────────
// Show invite details on the Join screen, and let a brand-new invitee create
// their account + join in one step.
router.get("/invite-info", c.getInviteInfo);
router.post("/invite-signup", verifyTurnstile, c.registerAndAcceptInvite);

router.use(protect);

router.post("/", c.createWorkspace);
router.get("/", c.getWorkspaces);

// Accept a team invite — the invited user isn't a member yet, so this must sit
// BEFORE the requireWorkspace guard (it only needs auth).
router.post("/accept-invite", c.acceptInvite);
// Permission catalogue for the invite UI (no workspace needed).
router.get("/permissions", c.getPermissionCatalogue);

router.use("/:workspaceId", requireWorkspace);
router.get("/:workspaceId", c.getWorkspace);
router.put("/:workspaceId", requireOwner, c.updateWorkspace);

// Activation checklist + AI knowledge
router.patch("/:workspaceId/activation", c.updateActivation);
router.put("/:workspaceId/ai-knowledge", requireOwner, c.updateAiKnowledge);
router.post(
  "/:workspaceId/ai-knowledge/import-url",
  requireOwner,
  c.importKnowledgeSource,
);
router.post(
  "/:workspaceId/ai-knowledge/import-doc",
  requireOwner,
  docUpload.single("file"),
  c.importKnowledgeDocument,
);
router.post(
  "/:workspaceId/ai-knowledge/sync-shopify",
  requireOwner,
  c.syncShopifyKnowledge,
);
router.post(
  "/:workspaceId/ai-knowledge/sources/:sourceId/resync",
  requireOwner,
  c.resyncKnowledgeSource,
);
router.delete(
  "/:workspaceId/ai-knowledge/sources/:sourceId",
  requireOwner,
  c.deleteKnowledgeSource,
);
router.put("/:workspaceId/smart-orders", requireOwner, c.updateSmartOrders);

// Team / onboarding
router.post("/:workspaceId/members/invite", requireOwner, c.inviteMember);
router.delete("/:workspaceId/members/:userId", requireOwner, c.removeMember);
router.post("/:workspaceId/invite", requireOwner, c.inviteMember);
router.get("/:workspaceId/invites", requireOwner, c.listInvites);
router.delete("/:workspaceId/invites/:email", requireOwner, c.revokeInvite);
router.put(
  "/:workspaceId/members/:userId/permissions",
  requireOwner,
  c.updateMemberPermissions,
);
router.post("/:workspaceId/complete-onboarding", c.completeOnboarding);
router.patch("/:workspaceId/onboarding-step", c.updateOnboardingStep);

// DM messages + automation settings
router.put("/:workspaceId/dm-messages", requireOwner, c.saveDmMessages);
router.put(
  "/:workspaceId/automation-settings",
  requireOwner,
  c.saveAutomationSettings,
);

// All-in-one automation config (read)
router.get("/:workspaceId/automation-config", c.getAutomationConfig);

// Triggers
router.get("/:workspaceId/keyword-triggers", c.getKeywordTriggers);
router.put(
  "/:workspaceId/keyword-triggers",
  requireOwner,
  c.saveKeywordTriggers,
);

router.get("/:workspaceId/dm-keyword-triggers", c.getDmKeywordTriggers);
router.put(
  "/:workspaceId/dm-keyword-triggers",
  requireOwner,
  c.saveDmKeywordTriggers,
);

router.get("/:workspaceId/story-reply-trigger", c.getStoryReplyTrigger);
router.put(
  "/:workspaceId/story-reply-trigger",
  requireOwner,
  requireFeature(FEATURES.STORY_REPLY),
  c.setStoryReplyTrigger,
);

router.get("/:workspaceId/story-mention-trigger", c.getStoryMentionTrigger);
router.put(
  "/:workspaceId/story-mention-trigger",
  requireOwner,
  requireFeature(FEATURES.STORY_MENTION),
  c.setStoryMentionTrigger,
);

router.get("/:workspaceId/share-to-story-trigger", c.getShareToStoryTrigger);
router.put(
  "/:workspaceId/share-to-story-trigger",
  requireOwner,
  requireFeature(FEATURES.SHARE_TO_STORY),
  c.setShareToStoryTrigger,
);

router.get("/:workspaceId/live-comment-triggers", c.getLiveCommentTriggers);
router.put(
  "/:workspaceId/live-comment-triggers",
  requireOwner,
  requireFeature(FEATURES.LIVE_COMMENT),
  c.setLiveCommentTriggers,
);

router.get("/:workspaceId/ref-url-triggers", c.getRefUrlTriggers);
router.put(
  "/:workspaceId/ref-url-triggers",
  requireOwner,
  requireFeature(FEATURES.REF_URL),
  c.setRefUrlTriggers,
);

router.get("/:workspaceId/conversation-starters", c.getConversationStarters);
router.put(
  "/:workspaceId/conversation-starters",
  requireOwner,
  requireFeature(FEATURES.CONVERSATION_STARTERS),
  c.setConversationStarters,
);

router.get("/:workspaceId/fallback-reply", c.getFallbackReply);
router.put("/:workspaceId/fallback-reply", requireOwner, c.setFallbackReply);

router.get("/:workspaceId/away-reply", c.getAwayReply);
router.put(
  "/:workspaceId/away-reply",
  requireOwner,
  requireFeature(FEATURES.BUSINESS_HOURS),
  c.setAwayReply,
);

// Business hours (schedule + timezone + enable flag)
router.get("/:workspaceId/business-hours", c.getBusinessHours);
router.put(
  "/:workspaceId/business-hours",
  requireOwner,
  requireFeature(FEATURES.BUSINESS_HOURS),
  c.setBusinessHours,
);

// AI Bot (Scale plan only)
router.get("/:workspaceId/ai-bot", c.getAiBotConfig);
router.put(
  "/:workspaceId/ai-bot",
  requireOwner,
  requireFeature(FEATURES.AI_BOT),
  c.saveAiBotConfig,
);

module.exports = router;
