const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
  getContacts,
  getContact,
  updateContact,
  deleteContact,
  exportContacts,
  importContacts,
  addTag,
} = require("../controllers/contactController");

router.use(protect);
router.use(requireWorkspace);

router.get("/export", exportContacts);
router.post("/import", importContacts);
router.route("/").get(getContacts);
router.route("/:id").get(getContact).put(updateContact).delete(deleteContact);
router.post("/:id/tags", addTag);

module.exports = router;
