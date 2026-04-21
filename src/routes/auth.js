const express = require("express");
const router = express.Router();
const {
  register,
  login,
  refreshToken,
  forgotPassword,
  resetPassword,
  getMe,
  googleAuth,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const { authLimiter } = require("../middleware/rateLimiter");

router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/refresh", refreshToken);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password", resetPassword);
router.get("/me", protect, getMe);
router.post("/google", googleAuth);

module.exports = router;
