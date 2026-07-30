const express = require("express");
const router = express.Router();
const { requireAdmin } = require("../middleware/adminAuth");
const {
  login,
  overview,
  listUsers,
  listSubscriptions,
  listActivity,
  timeline,
} = require("../controllers/adminController");

// Public — admin login (email + password from env → admin JWT)
router.post("/login", login);

// Everything below requires a valid admin token
router.use(requireAdmin);
router.get("/overview", overview);
router.get("/users", listUsers);
router.get("/subscriptions", listSubscriptions);
router.get("/activity", listActivity); // per-user funnel + activity table
router.get("/timeline", timeline); // live event feed

module.exports = router;
