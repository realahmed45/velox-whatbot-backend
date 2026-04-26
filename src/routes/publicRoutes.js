/**
 * Botlify — Public routes (no auth)
 * Link-in-Bio pages, click tracking.
 */
const express = require("express");
const router = express.Router();
const bio = require("../controllers/linkInBioController");

router.get("/bio/:slug", bio.getPublic);
router.post("/bio/:slug/click/:linkId", bio.trackClick);

module.exports = router;
