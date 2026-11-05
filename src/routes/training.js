/**
 * "Train your AI" — mounted at /api/training (see server.js).
 * Anyone on the team can read and test; changing what the AI tells guests
 * needs the settings permission.
 */
const express = require("express");
const router = express.Router();
const { protect, requireWorkspace, requirePermission } = require("../middleware/auth");
const c = require("../controllers/trainingController");

router.use(protect, requireWorkspace);

router.get("/", c.listFaqs);
router.get("/readiness", c.getReadiness);
router.post("/test", c.testAi);
router.put("/contacts", requirePermission("settings"), c.saveContacts);
router.put("/playbook", requirePermission("settings"), c.savePlaybook);
router.post("/reset", requirePermission("settings"), c.resetFaqs);
router.post("/", requirePermission("settings"), c.addFaq);
router.patch("/:id", requirePermission("settings"), c.updateFaq);
router.delete("/:id", requirePermission("settings"), c.deleteFaq);

module.exports = router;
