const rateLimit = require("express-rate-limit");

const rateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests — please try again in a minute",
  },
  skip: (req) => {
    // Skip rate limiting for Instagram webhooks (Meta verifies with signature)
    return req.path.startsWith("/instagram/webhook");
  },
});

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many auth attempts — please try again in 15 minutes",
  },
});

module.exports = rateLimiter;
module.exports.authLimiter = authLimiter;
