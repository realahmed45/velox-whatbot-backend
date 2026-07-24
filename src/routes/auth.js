const express = require("express");
const router = express.Router();
const { authLimiter } = require("../middleware/enhancedRateLimiter");
const { verifyTurnstile } = require("../middleware/turnstile");
const {
  register,
  login,
  refreshToken,
  forgotPassword,
  resetPassword,
  verifyEmailCode,
  resendVerificationCode,
  getMe,
  googleAuth,
  changePassword,
  setPassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

// Bot/abuse protection (Turnstile) + brute-force limiting on sensitive routes.
router.post("/register", authLimiter, verifyTurnstile, register);
router.post("/login", authLimiter, verifyTurnstile, login);
router.post("/refresh", refreshToken);
router.post("/forgot-password", authLimiter, verifyTurnstile, forgotPassword);
router.post("/reset-password", authLimiter, verifyTurnstile, resetPassword);
router.post("/verify-email", authLimiter, verifyEmailCode);
router.post("/resend-verification", authLimiter, resendVerificationCode);
router.get("/me", protect, getMe);
router.post("/google", googleAuth);

// Password management (authenticated).
router.put("/password", protect, authLimiter, changePassword);
router.post("/set-password", protect, authLimiter, setPassword);

module.exports = router;
