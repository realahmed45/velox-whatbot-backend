const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  exportContacts,
  importContacts,
  addTag,
  removeTag,
  optOutContact,
  optInContact,
  addNote,
} = require("../controllers/contactController");

router.use(protect);
router.use(requireWorkspace);

router.get("/export", exportContacts);
router.post("/import", importContacts);
router.route("/").get(getContacts).post(createContact);
router.route("/:id").get(getContact).put(updateContact).delete(deleteContact);
router.post("/:id/tags", addTag);
router.delete("/:id/tags/:tag", removeTag);
router.post("/:id/opt-out", optOutContact);
router.post("/:id/opt-in", optInContact);
router.post("/:id/notes", addNote);

module.exports = router;
