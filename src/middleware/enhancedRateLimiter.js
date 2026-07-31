/**
 * Botlify — Enhanced Rate Limiting
 * Endpoint-specific rate limits to prevent abuse
 */
const rateLimit = require("express-rate-limit");

// Global default limit (already in use)
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limiter for sensitive endpoints (billing, payments)
const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 requests per minute
  message: "Too many attempts. Please wait a minute and try again.",
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

// AI endpoint limiter (higher cost operations)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 AI requests per minute per user
  message: "AI rate limit reached. Please wait a minute.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Rate limit by user ID if authenticated
    return req.user?._id?.toString() || req.ip;
  },
});

// Auth endpoint limiter (prevent brute force on LOGIN / password routes).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 15, // attempts / 15 min / IP
  message: "Too many attempts. Please try again in a few minutes.",
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful logins
});

// Registration limiter — more forgiving than login. Registration is already
// bot-gated by Turnstile, and legitimate users often retry (email taken, weak
// password, network). A tight 5/15min brute-force cap here just locks real
// people out. Only genuinely repeated signups from ONE IP are throttled, and
// successful signups don't count toward the limit.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.REGISTER_RATE_LIMIT_MAX) || 30, // per hour / IP
  message: "Too many sign-up attempts from this network. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Webhook receiver limiter
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 webhooks per minute
  message: "Webhook rate limit exceeded.",
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  globalLimiter,
  strictLimiter,
  aiLimiter,
  authLimiter,
  registerLimiter,
  webhookLimiter,
};
