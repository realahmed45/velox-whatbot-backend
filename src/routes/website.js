/**
 * The hotel's own website (botlify.site/<slug>) — managed by the owner.
 * Public reads live in routes/publicSite.js.
 */
const express = require("express");
const router = express.Router();
const { protect, requireWorkspace, requireOwner } = require("../middleware/auth");
const { uploadImage } = require("../services/cloudinaryService");
const c = require("../controllers/websiteController");

router.use(protect);
router.use(requireWorkspace);

router.get("/", c.getWebsite);
router.get("/draft", c.getDraft);
router.get("/slug-check", c.checkSlug);
router.post("/generate", requireOwner, c.generateWebsite);
router.patch("/", requireOwner, c.updateWebsite);
router.post("/photo", requireOwner, uploadImage.single("file"), c.uploadPhoto);

module.exports = router;
