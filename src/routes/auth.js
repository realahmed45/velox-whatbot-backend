const express = require("express");
const router = express.Router();
const { authLimiter } = require("../middleware/enhancedRateLimiter");
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

router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/refresh", refreshToken);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password", authLimiter, resetPassword);
router.get("/me", protect, getMe);
router.post("/google", googleAuth);

module.exports = router;
