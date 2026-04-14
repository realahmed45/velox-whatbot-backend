const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const {
  createWorkspace,
  getWorkspaces,
  getWorkspace,
  updateWorkspace,
  connectUltramsg,
  getUltramsgQR,
  connectMeta,
  disconnectWhatsApp,
  inviteMember,
  completeOnboarding,
  updateOnboardingStep,
} = require("../controllers/workspaceController");

router.use(protect);

router.post("/", createWorkspace);
router.get("/", getWorkspaces);

router.use("/:workspaceId", requireWorkspace);
router.get("/:workspaceId", getWorkspace);
router.put("/:workspaceId", requireOwner, updateWorkspace);

router.post("/:workspaceId/connect/ultramsg", requireOwner, connectUltramsg);
router.get("/:workspaceId/connect/ultramsg/qr", requireOwner, getUltramsgQR);
router.post("/:workspaceId/connect/meta", requireOwner, connectMeta);

router.post("/:workspaceId/connect-ultramsg", requireOwner, connectUltramsg);
router.post("/:workspaceId/connect-meta", requireOwner, connectMeta);
router.post(
  "/:workspaceId/disconnect-whatsapp",
  requireOwner,
  disconnectWhatsApp,
);
router.post("/:workspaceId/members/invite", requireOwner, inviteMember);
router.post("/:workspaceId/invite", requireOwner, inviteMember);
router.post("/:workspaceId/complete-onboarding", completeOnboarding);
router.patch("/:workspaceId/onboarding-step", updateOnboardingStep);

module.exports = router;
