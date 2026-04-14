const { Server } = require("socket.io");
const { verifyAccessToken } = require("../utils/jwt");
const User = require("../models/User");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:5173",
      methods: ["GET", "POST"],
      credentials: true,
    },
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  });

  // ─── Auth middleware ─────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.split(" ")[1];
      if (!token) return next(new Error("Unauthorized"));

      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.id).select(
        "_id name email workspaces activeWorkspace",
      );
      if (!user) return next(new Error("User not found"));

      socket.user = user;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  // ─── Connection ──────────────────────────────────────────
  io.on("connection", async (socket) => {
    logger.info(`Socket connected: ${socket.id} (user: ${socket.user._id})`);

    // Join workspace rooms the user belongs to
    const workspaces = await Workspace.find({
      $or: [{ owner: socket.user._id }, { "members.user": socket.user._id }],
    }).select("_id");

    workspaces.forEach((ws) => {
      socket.join(`workspace:${ws._id}`);
    });

    // Handle workspace switch
    socket.on("workspace:switch", async (workspaceId) => {
      const ws =
        await Workspace.findById(workspaceId).select("_id owner members");
      if (!ws) return;
      const isAllowed =
        ws.owner.toString() === socket.user._id.toString() ||
        ws.members.some(
          (m) => m.user.toString() === socket.user._id.toString(),
        );
      if (isAllowed) {
        socket.join(`workspace:${workspaceId}`);
        socket.emit("workspace:joined", { workspaceId });
      }
    });

    // Typing indicator
    socket.on("agent:typing", ({ conversationId, workspaceId }) => {
      socket.to(`workspace:${workspaceId}`).emit("agent:typing", {
        conversationId,
        userId: socket.user._id,
        userName: socket.user.name,
      });
    });

    // Mark messages as read
    socket.on("messages:read", ({ conversationId, workspaceId }) => {
      socket
        .to(`workspace:${workspaceId}`)
        .emit("messages:read", { conversationId });
    });

    socket.on("disconnect", () => {
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });

  logger.info("Socket.io initialized");
  return io;
};

const getIO = () => io;

module.exports = { initSocket, getIO };
