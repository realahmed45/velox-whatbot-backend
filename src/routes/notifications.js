/**
 * /api/notifications — the dashboard bell.
 *   GET    /                 ?limit=30&before=<iso>&unread=1 → { notifications, unreadCount, hasMore }
 *   GET    /unread-count     → { unreadCount }
 *   POST   /:id/read         → { success, unreadCount }
 *   POST   /read-all         → { success, unreadCount: 0 }
 *   DELETE /:id              → { success, unreadCount }
 */
const express = require("express");
const asyncHandler = require("express-async-handler");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const Notification = require("../models/Notification");
const { unreadCount } = require("../services/notificationService");

router.use(protect, requireWorkspace);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const q = { workspaceId: req.workspace._id };
    if (req.query.unread === "1") q.readAt = null;
    if (req.query.before) q.createdAt = { $lt: new Date(req.query.before) };
    const rows = await Notification.find(q).sort({ createdAt: -1 }).limit(limit + 1).lean();
    res.json({
      notifications: rows.slice(0, limit),
      hasMore: rows.length > limit,
      unreadCount: await unreadCount(req.workspace._id),
    });
  }),
);

router.get(
  "/unread-count",
  asyncHandler(async (req, res) => res.json({ unreadCount: await unreadCount(req.workspace._id) })),
);

router.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ workspaceId: req.workspace._id, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ success: true, unreadCount: 0 });
  }),
);

router.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    await Notification.updateOne({ _id: req.params.id, workspaceId: req.workspace._id }, { $set: { readAt: new Date() } });
    res.json({ success: true, unreadCount: await unreadCount(req.workspace._id) });
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await Notification.deleteOne({ _id: req.params.id, workspaceId: req.workspace._id });
    res.json({ success: true, unreadCount: await unreadCount(req.workspace._id) });
  }),
);

module.exports = router;
