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

// ─── Route Imports ─────────────────────────────────────────
const authRoutes = require("./src/routes/auth");
const workspaceRoutes = require("./src/routes/workspace");
const flowRoutes = require("./src/routes/flows");
const inboxRoutes = require("./src/routes/inbox");
const contactRoutes = require("./src/routes/contacts");
const orderRoutes = require("./src/routes/orders");
const analyticsRoutes = require("./src/routes/analytics");
const billingRoutes = require("./src/routes/billing");
const instagramRoutes = require("./src/routes/instagram");
const broadcastRoutes = require("./src/routes/broadcasts");
const uploadRoutes = require("./src/routes/upload");
const planRoutes = require("./src/routes/plans");
const scheduledPostsRoutes = require("./src/routes/scheduledPosts");
const aiRoutes = require("./src/routes/ai");
const dripRoutes = require("./src/routes/drip");
const giveawayRoutes = require("./src/routes/giveaways");
const competitorRoutes = require("./src/routes/competitors");
const integrationRoutes = require("./src/routes/integrations");
const linkInBioRoutes = require("./src/routes/linkInBio");
const publicRoutes = require("./src/routes/publicRoutes");
const referralRoutes = require("./src/routes/referral");
const webhookRoutes = require("./src/routes/webhooks");

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

// ─── Email Debug (dev only) ───────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.get("/api/debug/test-email", async (req, res) => {
    try {
      const { sendVerificationEmail } = require("./src/services/emailService");
      const to = req.query.to || "realahmedali4@gmail.com";
      await sendVerificationEmail({
        to,
        name: "Test User",
        verificationUrl: `${process.env.CLIENT_URL}/verify-email?token=test123`,
      });
      res.json({ success: true, message: `Test email sent to ${to}` });
    } catch (err) {
      res
        .status(500)
        .json({ success: false, error: err.message, code: err.code });
    }
  });
}

// ─── API Routes ────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/flows", flowRoutes);
app.use("/api/inbox", inboxRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/orders", orderRoutes);
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
app.use("/api/giveaways", giveawayRoutes);
app.use("/api/competitors", competitorRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/bio", linkInBioRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/referral", referralRoutes);
app.use("/api/webhooks", webhookRoutes);

// ─── 404 ───────────────────────────────────────────────────
app.use("*", (req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// ─── Error Handler ─────────────────────────────────────────
app.use(errorHandler);

// ─── Socket.io ─────────────────────────────────────────────
initSocket(server);

// ─── Background Jobs ───────────────────────────────────────
initQueues();

// ─── Smart Orders Cron Jobs ────────────────────────────────
try {
  require("./src/jobs/smartOrdersCron").startCrons();
} catch (err) {
  console.warn(`[smartOrders] cron init failed: ${err.message}`);
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

// Close expired giveaways every 5 minutes
const { processExpiredGiveaways } = require("./src/jobs/giveawayJob");
cron.schedule("*/5 * * * *", () => {
  processExpiredGiveaways().catch((e) =>
    logger.warn("[Cron] processExpiredGiveaways error: " + e.message),
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

logger.info(
  "Cron jobs registered: follow-ups (30min), scheduled-posts (5min), drip (1min), giveaways (5min), followers (6h)",
);

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
