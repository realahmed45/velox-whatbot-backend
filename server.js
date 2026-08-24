require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");

const connectDB = require("./src/config/db");
const { initSocket } = require("./src/socket");
const { initQueues } = require("./src/jobs");
const errorHandler = require("./src/middleware/errorHandler");
const rateLimiter = require("./src/middleware/rateLimiter");
const logger = require("./src/utils/logger");
const errorMonitor = require("./src/utils/errorMonitor");

// Initialize error monitoring first so startup faults are captured too.
errorMonitor.init();

// ─── Route Imports ─────────────────────────────────────────
const authRoutes = require("./src/routes/auth");
const workspaceRoutes = require("./src/routes/workspace");
const flowRoutes = require("./src/routes/flows");
const inboxRoutes = require("./src/routes/inbox");
const contactRoutes = require("./src/routes/contacts");
const analyticsRoutes = require("./src/routes/analytics");
const billingRoutes = require("./src/routes/billing");
const instagramRoutes = require("./src/routes/instagram");
const broadcastRoutes = require("./src/routes/broadcasts");
const uploadRoutes = require("./src/routes/upload");
const planRoutes = require("./src/routes/plans");
const scheduledPostsRoutes = require("./src/routes/scheduledPosts");
const aiRoutes = require("./src/routes/ai");
const dripRoutes = require("./src/routes/drip");
const integrationRoutes = require("./src/routes/integrations");
const adminRoutes = require("./src/routes/admin");
const hotelRoutes = require("./src/routes/hotel");
const channelRoutes = require("./src/routes/channels");
const consultantRoutes = require("./src/routes/consultants");
const transferRoutes = require("./src/routes/transfers");
const agentRoutes = require("./src/routes/agent");

const app = express();
const server = http.createServer(app);

// Render / Vercel / Heroku put us behind a proxy. Trust one hop so
// express-rate-limit can read X-Forwarded-For safely.
app.set("trust proxy", 1);

// ─── Database ──────────────────────────────────────────────
connectDB();

// ─── Security ──────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false, // API server; CSP handled at frontend host
  }),
);

// Permissions-Policy: lock down browser APIs we never use.
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  );
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      const allowed = (process.env.CORS_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Default allow-list (always on, regardless of env):
      //  - localhost / 127.0.0.1 (any port) for dev
      //  - any *.vercel.app preview/prod
      //  - any *.onrender.com (server-to-server)
      //  - botlify.site apex + www subdomain (production frontend)
      const fallback = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
        /\.vercel\.app$/,
        /\.onrender\.com$/,
        /^https?:\/\/(www\.)?botlify\.site$/,
      ];
      if (!origin) return cb(null, true); // server-to-server / curl / health
      if (allowed.includes(origin)) return cb(null, true);
      if (fallback.some((re) => re.test(origin))) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id"],
  }),
);

// ─── Body Parsing ──────────────────────────────────────────
// Instagram webhook needs raw body for signature verification.
// Apply express.raw to BOTH webhook paths (Meta + Zernio/BotlifyIG) so
// req.body is always a Buffer before express.json can parse it.
app.use(
  ["/api/instagram/webhook", "/api/instagram/webhook/botlify"],
  express.raw({ type: "*/*" }), // match any content-type Zernio may send
);
// Lemon Squeezy needs the raw body to verify its HMAC signature.
app.use("/api/billing/lemonsqueezy/webhook", express.raw({ type: "*/*" }));
// Paddle needs the raw body to verify its Paddle-Signature.
app.use("/api/billing/paddle/webhook", express.raw({ type: "*/*" }));
// Creem needs the raw body to verify its creem-signature.
app.use("/api/billing/creem/webhook", express.raw({ type: "*/*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─── Input Sanitization (XSS Protection) ──────────────────
const sanitizeInput = require("./src/middleware/sanitizeInput");
app.use(sanitizeInput);

// ─── Compression & Logging ─────────────────────────────────
app.use(compression());
app.use(
  morgan("combined", {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: (req) => req.path === "/health",
  }),
);

// ─── API Request Logger (Audit Trail) ─────────────────────
const { apiLogger } = require("./src/middleware/apiLogger");
app.use("/api/", apiLogger);

// ─── Rate Limiting ─────────────────────────────────────────
app.use("/api/", rateLimiter);

// ─── Health Check ──────────────────────────────────────────
app.get("/health", (req, res) => {
  let redisStatus = "unknown";
  try {
    const { getRedisClient } = require("./src/config/redis");
    const r = getRedisClient && getRedisClient();
    redisStatus = r?.status || "unavailable";
  } catch {
    redisStatus = "error";
  }
  const mongoose = require("mongoose");
  const mongoStateMap = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };
  res.json({
    status: "ok",
    version: "6",
    timestamp: new Date().toISOString(),
    services: {
      redis: redisStatus,
      mongo: mongoStateMap[mongoose.connection.readyState] || "unknown",
    },
  });
});

// ─── API Routes ────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/flows", flowRoutes);
app.use("/api/inbox", inboxRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/instagram", instagramRoutes);
app.use("/api/broadcasts", broadcastRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/scheduled-posts", scheduledPostsRoutes);
app.use("/api/workspaces/:workspaceId/ai", aiRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/drip-campaigns", dripRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/hotel", hotelRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/consultants", consultantRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/pms", require("./src/routes/pms"));
app.use("/api/growth", require("./src/routes/growth"));

// Public: the hotel's own direct-booking page at /book/<slug> (no auth).
app.use("/api/book", require("./src/routes/publicBooking"));
app.use("/api/agent", agentRoutes);

// Public: Channex (OTA) reservation webhook — token-verified in the handler.
app.post(
  "/api/channex/webhook",
  require("./src/controllers/hotelController").handleChannexWebhook,
);

// Public: Beds24 (OTA) booking webhook — token-verified in the handler.
// Beds24 cannot register this over its API, so the hotel pastes the URL into
// Settings > Properties > Access > Booking webhooks. The 2-minute poll job
// below covers them until they do (and if a webhook is ever dropped).
app.post(
  "/api/beds24/webhook",
  require("./src/controllers/hotelController").handleBeds24Webhook,
);

// Public: business-category picker list for onboarding.
app.get("/api/verticals", require("./src/controllers/verticalController").listVerticals);

// Public: "Book a Demo" lead capture from the marketing site.
app.post("/api/demo", require("./src/controllers/demoController").bookDemo);

// ─── 404 ───────────────────────────────────────────────────
app.use("*", (req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ─── Error Handler ─────────────────────────────────────────
app.use(errorHandler);

// ─── Socket.io ─────────────────────────────────────────────
initSocket(server);

// ─── Background Jobs ───────────────────────────────────────
try {
  initQueues();
} catch (err) {
  logger.warn(`initQueues failed: ${err.message} — continuing without queues`);
}

// ─── Instagram Cron Jobs ───────────────────────────────────
// Note: Instagram Graph API does NOT expose follow events or a followers list,
// so we do not poll for new followers. We only process scheduled follow-ups.
const cron = require("node-cron");
const {
  processScheduledFollowups,
} = require("./src/services/instagram/automationEngine");

cron.schedule("*/30 * * * *", () => {
  processScheduledFollowups().catch((e) =>
    logger.warn("[Cron] processScheduledFollowups error: " + e.message),
  );
});

// Process scheduled posts every 5 minutes
const { processScheduledPosts } = require("./src/jobs/scheduledPostsJob");
cron.schedule("*/5 * * * *", () => {
  processScheduledPosts().catch((e) =>
    logger.warn("[Cron] processScheduledPosts error: " + e.message),
  );
});

// Process drip campaign enrollments every 1 minute
const { processDripEnrollments } = require("./src/jobs/dripJob");
cron.schedule("*/1 * * * *", () => {
  processDripEnrollments().catch((e) =>
    logger.warn("[Cron] processDripEnrollments error: " + e.message),
  );
});

// Poll follower counts every 6 hours (IG has no follow webhook)
const { pollFollowers } = require("./src/jobs/followerPollingJob");
cron.schedule("0 */6 * * *", () => {
  pollFollowers().catch((e) =>
    logger.warn("[Cron] pollFollowers error: " + e.message),
  );
});

// Refresh AI knowledge (websites + Shopify) daily at 3am so the bot stays current
const { resyncStaleKnowledge } = require("./src/jobs/knowledgeResyncJob");
cron.schedule("0 3 * * *", () => {
  resyncStaleKnowledge().catch((e) =>
    logger.warn("[Cron] resyncStaleKnowledge error: " + e.message),
  );
});

// Email trial-ending reminders daily at 9am UTC (once per trial).
const { sendTrialReminders } = require("./src/jobs/trialReminderJob");
cron.schedule("0 9 * * *", () => {
  sendTrialReminders().catch((e) =>
    logger.warn("[Cron] sendTrialReminders error: " + e.message),
  );
});

// Auto-disconnect Instagram for trials that lapsed without paying, so the
// hosted provider stops billing us. Paid + lifetime accounts are never touched.
// Runs hourly so a lapsed trial is dropped promptly.
const { expireTrials } = require("./src/jobs/expireTrialsJob");
cron.schedule("15 * * * *", () => {
  expireTrials().catch((e) =>
    logger.warn("[Cron] expireTrials error: " + e.message),
  );
});

// Regenerate pricing suggestions every morning so the owner opens Today to a
// fresh, short list. Nothing is pushed to the OTAs — each one needs a tap.
const { generateAll } = require("./src/services/revenue/revenueService");
cron.schedule("0 5 * * *", () => {
  generateAll().catch((e) =>
    logger.warn("[Cron] revenue generateAll error: " + e.message),
  );
});

// Email each hotel its monthly booking-commission statement and close the
// period in the ledger. 06:00 UTC on the 1st, after the month has fully rolled
// over in every timezone we serve.
// Fold recent bookings into unified Guest profiles hourly. Recomputes stats
// from scratch each pass, so re-seeing a booking is a no-op, not a double count.
const { syncGuests } = require("./src/jobs/guestSyncJob");
cron.schedule("35 * * * *", () => {
  syncGuests().catch((e) => logger.warn("[Cron] syncGuests error: " + e.message));
});

const { sendCommissionInvoices } = require("./src/jobs/commissionInvoiceJob");
cron.schedule("0 6 1 * *", () => {
  sendCommissionInvoices().catch((e) =>
    logger.warn("[Cron] sendCommissionInvoices error: " + e.message),
  );
});

// Nudge guests arriving in 2 days with the hotel's extras. 10:00 UTC daily.
const { runUpsellNudges } = require("./src/jobs/upsellNudgeJob");
cron.schedule("0 10 * * *", () => {
  runUpsellNudges().catch((e) =>
    logger.warn("[Cron] runUpsellNudges error: " + e.message),
  );
});

// Ask yesterday's checkouts for a review. 08:00 UTC daily.
const { runReviewRequests } = require("./src/jobs/reviewRequestJob");
cron.schedule("0 8 * * *", () => {
  runReviewRequests().catch((e) =>
    logger.warn("[Cron] runReviewRequests error: " + e.message),
  );
});

// Pull Beds24 bookings modified in the last 10 minutes, every 2. The webhook
// is the fast path; this is the one that guarantees a reservation still lands
// when the hotel hasn't set the webhook up yet, or a delivery was dropped.
const { pollBeds24Bookings } = require("./src/jobs/beds24PollJob");
cron.schedule("*/2 * * * *", () => {
  pollBeds24Bookings().catch((e) =>
    logger.warn("[Cron] pollBeds24Bookings error: " + e.message),
  );
});

logger.info(
  "Cron jobs registered: follow-ups (30min), scheduled-posts (5min), drip (1min), followers (6h), knowledge-resync (daily), trial-reminders (daily 9am), expire-trials (hourly), guest-sync (hourly), commission-invoices (monthly), pricing-suggestions (daily 5am), review-requests (daily 8am), upsell-nudges (daily 10am), beds24-poll (2min)",
);

// ─── Configuration readiness ───────────────────────────────
// Say plainly at boot what is and isn't wired up. Silent misconfiguration
// (e.g. OTA sync pointed at staging) is the expensive kind.
try {
  require("./src/utils/readiness").checkReadiness();
} catch (e) {
  logger.warn("[readiness] check failed: " + e.message);
}

// ─── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`Botlify API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

// ─── Graceful Shutdown ─────────────────────────────────────
process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down gracefully");
  server.close(() => process.exit(0));
});

module.exports = app;
