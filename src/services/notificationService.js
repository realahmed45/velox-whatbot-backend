/**
 * notificationService — create + push notifications to the hotel's dashboard.
 *
 *   notify(workspaceId, { type, title, body, link, channel, priority, dedupeKey, data })
 *
 * Never throws (a failed notification must never break a booking or a reply).
 * With a dedupeKey, an UNREAD notification with the same key is refreshed and
 * bumped to the top instead of stacking duplicates (e.g. a chatty guest).
 * Every create/update is emitted on the socket as "notification:new" to the
 * workspace room, with the fresh unread count.
 */
const logger = require("../utils/logger");
const Notification = require("../models/Notification");

async function unreadCount(workspaceId) {
  return Notification.countDocuments({ workspaceId, readAt: null });
}

async function notify(workspaceId, n = {}) {
  try {
    if (!workspaceId || !n.type || !n.title) return null;
    let doc = null;
    if (n.dedupeKey) {
      doc = await Notification.findOneAndUpdate(
        { workspaceId, dedupeKey: n.dedupeKey, readAt: null },
        {
          $set: {
            title: n.title,
            body: n.body || "",
            link: n.link || "",
            channel: n.channel || "",
            priority: n.priority || "normal",
            data: n.data || {},
            createdAt: new Date(), // bump to the top
          },
        },
        { new: true, timestamps: false },
      );
    }
    if (!doc) {
      doc = await Notification.create({
        workspaceId,
        type: n.type,
        title: String(n.title).slice(0, 160),
        body: String(n.body || "").slice(0, 500),
        link: n.link || "",
        channel: n.channel || "",
        priority: n.priority || "normal",
        dedupeKey: n.dedupeKey || null,
        data: n.data || {},
      });
    }
    try {
      const { getIO } = require("../socket");
      const io = getIO();
      if (io) {
        io.to(`workspace:${workspaceId}`).emit("notification:new", {
          notification: doc,
          unreadCount: await unreadCount(workspaceId),
        });
      }
    } catch {
      /* socket not up (scripts/tests) — the bell still loads from the API */
    }
    return doc;
  } catch (err) {
    logger.warn(`[notify] failed ws=${workspaceId} type=${n.type}: ${err.message}`);
    return null;
  }
}

const CHANNEL_LABEL = {
  whatsapp: "WhatsApp",
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  expedia: "Expedia",
  trip_com: "Trip.com",
  agoda: "Agoda",
  direct: "your booking page",
  manual: "manual entry",
};
const channelLabel = (c) => CHANNEL_LABEL[c] || (c ? String(c).replace(/_/g, " ") : "a channel");

module.exports = { notify, unreadCount, channelLabel };
