/**
 * Public hotel websites — NO auth. Read-only: the assembled site by slug.
 */
const express = require("express");
const router = express.Router();
const { getPublicSite } = require("../controllers/websiteController");

router.get("/site/:slug", getPublicSite);

module.exports = router;
