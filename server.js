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
const whatsappRoutes = require("./src/routes/whatsapp");
const broadcastRoutes = require("./src/routes/broadcasts");
const uploadRoutes = require("./src/routes/upload");

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

const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://localhost:5173",
]
  .filter(Boolean)
  .map((o) => o.replace(/\/$/, "")); // strip trailing slashes

app.use(
  cors({
    origin: (origin, callback) => {
      // allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin.replace(/\/$/, ""))) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id"],
  }),
);

// ─── Body Parsing ──────────────────────────────────────────
// WhatsApp webhook needs raw body for signature verification
app.use("/api/whatsapp/webhook", express.raw({ type: "application/json" }));
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
  res.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// ─── Email Debug (remove after confirming email works) ─────
app.get("/debug/test-email", async (req, res) => {
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
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/broadcasts", broadcastRoutes);
app.use("/api/upload", uploadRoutes);

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

// ─── Start Server ──────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(
    `Velox-Whatbot API running on port ${PORT} [${process.env.NODE_ENV}]`,
  );
});

// ─── Graceful Shutdown ─────────────────────────────────────
process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down gracefully");
  server.close(() => process.exit(0));
});

module.exports = app;
