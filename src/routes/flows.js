const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
  getFlows,
  getFlow,
  createFlow,
  updateFlow,
  deleteFlow,
  duplicateFlow,
  getTemplates,
  createFromTemplate,
  getStarters,
  createFromStarter,
  updatePriority,
} = require("../controllers/flowController");

router.use(protect);
router.use(requireWorkspace);

router.get("/templates", getTemplates);
router.post("/from-template", createFromTemplate);
router.get("/starters", getStarters);
router.post("/from-starter", createFromStarter);

router.route("/").get(getFlows).post(createFlow);
router.route("/:id").get(getFlow).put(updateFlow).delete(deleteFlow);
router.post("/:id/duplicate", duplicateFlow);
router.patch("/:id/priority", updatePriority);

module.exports = router;
