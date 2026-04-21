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
const analyticsRoutes = require("./src/routes/analytics");
const billingRoutes = require("./src/routes/billing");
const instagramRoutes = require("./src/routes/instagram");
const broadcastRoutes = require("./src/routes/broadcasts");
const uploadRoutes = require("./src/routes/upload");
const planRoutes = require("./src/routes/plans");

const app = express();
const server = http.createServer(app);

// ─── Database ──────────────────────────────────────────────
connectDB();

// ─── Security ──────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id"],
  }),
);

// ─── Body Parsing ──────────────────────────────────────────
// Instagram webhook needs raw body for Meta signature verification
app.use("/api/instagram/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─── Compression & Logging ─────────────────────────────────
app.use(compression());
app.use(
  morgan("combined", {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: (req) => req.path === "/health",
  }),
);

// ─── Rate Limiting ─────────────────────────────────────────
app.use("/api/", rateLimiter);

// ─── Health Check ──────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", version: "6", timestamp: new Date().toISOString() }),
);

// ─── Email Debug (remove after confirming email works) ─────
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

logger.info("Cron jobs registered: follow-ups (30min)");

// ─── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`Flowgram API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

// ─── Graceful Shutdown ─────────────────────────────────────
process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down gracefully");
  server.close(() => process.exit(0));
});

module.exports = app;
