const asyncHandler = require("express-async-handler");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const Contact = require("../models/Contact");
const Flow = require("../models/Flow");
const moment = require("moment");

// @GET /api/analytics/overview — Dashboard summary cards
const getOverview = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const now = new Date();
  const todayStart = moment().startOf("day").toDate();
  const weekStart = moment().startOf("isoWeek").toDate();
  const monthStart = moment().startOf("month").toDate();

  const [
    messagesToday,
    conversationsThisWeek,
    leadsThisMonth,
    activeConversations,
    totalResolved,
    totalConversations,
    botResolvedConversations,
    totalMessages,
    inboundMessages,
    outboundMessages,
    botOutbound,
    igMessages,
    waMessages,
    totalContacts,
  ] = await Promise.all([
    Message.countDocuments({ workspaceId, createdAt: { $gte: todayStart } }),
    Conversation.countDocuments({
      workspaceId,
      createdAt: { $gte: weekStart },
    }),
    Contact.countDocuments({
      workspaceId,
      isDeleted: false,
      $or: [
        { name: { $exists: true, $ne: null } },
        { email: { $exists: true, $ne: null } },
      ],
      firstSeenAt: { $gte: monthStart },
    }),
    Conversation.countDocuments({
      workspaceId,
      status: { $in: ["bot_active", "human_active", "awaiting_human"] },
      lastMessageAt: { $gte: moment().subtract(24, "hours").toDate() },
    }),
    Conversation.countDocuments({ workspaceId, status: "resolved" }),
    Conversation.countDocuments({ workspaceId }),
    Conversation.countDocuments({
      workspaceId,
      status: "resolved",
      resolvedBy: { $exists: false },
    }),
    // Flat message counts
    Message.countDocuments({ workspaceId }),
    Message.countDocuments({ workspaceId, direction: "inbound" }),
    Message.countDocuments({ workspaceId, direction: "outbound" }),
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      sender: "bot",
    }),
    Message.countDocuments({ workspaceId, channelType: "instagram" }),
    Message.countDocuments({
      workspaceId,
      channelType: { $in: ["whatsapp", "wa"] },
    }),
    Contact.countDocuments({ workspaceId, isDeleted: false }),
  ]);

  const botResolutionRate =
    totalResolved > 0
      ? Math.round((botResolvedConversations / totalResolved) * 100)
      : 0;
  const botHandledPct =
    totalMessages > 0 ? Math.round((botOutbound / totalMessages) * 100) : 0;
  const replyRate =
    inboundMessages > 0
      ? Math.round((outboundMessages / inboundMessages) * 100)
      : 0;

  const planLimits = req.workspace.getPlanLimits();
  const usage = req.workspace.usage || {};

  const overview = {
    // Dashboard summary cards (flat keys the OverviewPage reads directly)
    totalMessages,
    inboundMessages,
    outboundMessages,
    igMessages,
    waMessages,
    totalContacts,
    replyRate,
    botHandled: botOutbound,
    humanHandled: outboundMessages - botOutbound,
    botHandledPct,
    // Legacy / AnalyticsPage keys
    messagesToday,
    conversationsThisWeek,
    leadsThisMonth,
    activeConversations,
    botResolutionRate: `${botResolutionRate}%`,
    planUsage: {
      used: usage.messagesThisMonth || 0,
      limit: planLimits.messages,
      percent:
        planLimits.messages === Infinity
          ? 0
          : Math.round(
              ((usage.messagesThisMonth || 0) / planLimits.messages) * 100,
            ),
    },
  };

  res.json({ success: true, overview });
});

// @GET /api/analytics/messages-over-time — Chart data
const getMessagesOverTime = asyncHandler(async (req, res) => {
  const { period = "weekly" } = req.query;
  const workspaceId = req.workspace._id;

  let groupFormat, startDate, numBuckets;
  switch (period) {
    case "daily":
      groupFormat = "%H:00";
      startDate = moment().startOf("day").toDate();
      numBuckets = 24;
      break;
    case "monthly":
      groupFormat = "%Y-%m-%d";
      startDate = moment().startOf("month").toDate();
      numBuckets = 30;
      break;
    default: // weekly
      groupFormat = "%Y-%m-%d";
      startDate = moment().subtract(7, "days").startOf("day").toDate();
      numBuckets = 7;
  }

  const data = await Message.aggregate([
    { $match: { workspaceId, createdAt: { $gte: startDate } } },
    {
      $group: {
        _id: { $dateToString: { format: groupFormat, date: "$createdAt" } },
        inbound: {
          $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] },
        },
        outbound: {
          $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  res.json({ success: true, data, period });
});

// @GET /api/analytics/peak-hours — Heatmap data
const getPeakHours = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const thirtyDaysAgo = moment().subtract(30, "days").toDate();

  const data = await Message.aggregate([
    {
      $match: {
        workspaceId,
        direction: "inbound",
        createdAt: { $gte: thirtyDaysAgo },
      },
    },
    {
      $group: {
        _id: {
          day: { $dayOfWeek: "$createdAt" },
          hour: { $hour: "$createdAt" },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.day": 1, "_id.hour": 1 } },
  ]);

  res.json({ success: true, data });
});

// @GET /api/analytics/flows — Flow performance
const getFlowAnalytics = asyncHandler(async (req, res) => {
  const flows = await Flow.find({
    workspaceId: req.workspace._id,
    status: "active",
  })
    .select("name stats")
    .sort({ "stats.totalTriggers": -1 })
    .limit(10);

  res.json({ success: true, flows });
});

// @GET /api/analytics/contacts-growth — Contact growth trend
const getContactsGrowth = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const thirtyDaysAgo = moment().subtract(30, "days").toDate();

  const data = await Contact.aggregate([
    {
      $match: {
        workspaceId,
        isDeleted: false,
        firstSeenAt: { $gte: thirtyDaysAgo },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$firstSeenAt" } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  res.json({ success: true, data });
});

module.exports = {
  getOverview,
  getMessagesOverTime,
  getPeakHours,
  getFlowAnalytics,
  getContactsGrowth,
};
