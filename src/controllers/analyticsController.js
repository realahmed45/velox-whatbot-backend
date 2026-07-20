const asyncHandler = require("express-async-handler");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const Contact = require("../models/Contact");
const Flow = require("../models/Flow");
const moment = require("moment");

// Resolve channel filter from query (?channel=instagram|whatsapp).
// Returns objects to spread into Message / Conversation / Contact `$match`/find.
const channelFilters = (req) => {
  const c = (req.query.channel || "").toLowerCase();
  if (c === "instagram") {
    return {
      msg: { channelType: "instagram" },
      conv: { channelType: "instagram" },
      contact: { igUserId: { $type: "string" } },
    };
  }
  if (c === "whatsapp" || c === "wa") {
    return {
      msg: { channelType: { $in: ["whatsapp", "wa"] } },
      conv: { channelType: { $in: ["whatsapp", "wa"] } },
      contact: { phone: { $type: "string" } },
    };
  }
  return { msg: {}, conv: {}, contact: {} };
};

// @GET /api/analytics/overview — Dashboard summary cards
const getOverview = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const ch = channelFilters(req);
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
    Message.countDocuments({
      workspaceId,
      ...ch.msg,
      createdAt: { $gte: todayStart },
    }),
    Conversation.countDocuments({
      workspaceId,
      ...ch.conv,
      createdAt: { $gte: weekStart },
    }),
    Contact.countDocuments({
      workspaceId,
      isDeleted: false,
      ...ch.contact,
      $or: [
        { name: { $exists: true, $ne: null } },
        { email: { $exists: true, $ne: null } },
      ],
      firstSeenAt: { $gte: monthStart },
    }),
    Conversation.countDocuments({
      workspaceId,
      ...ch.conv,
      status: { $in: ["bot_active", "human_active", "awaiting_human"] },
      lastMessageAt: { $gte: moment().subtract(24, "hours").toDate() },
    }),
    Conversation.countDocuments({
      workspaceId,
      ...ch.conv,
      status: "resolved",
    }),
    Conversation.countDocuments({ workspaceId, ...ch.conv }),
    Conversation.countDocuments({
      workspaceId,
      ...ch.conv,
      status: "resolved",
      resolvedBy: { $exists: false },
    }),
    // Flat message counts
    Message.countDocuments({ workspaceId, ...ch.msg }),
    Message.countDocuments({ workspaceId, ...ch.msg, direction: "inbound" }),
    Message.countDocuments({ workspaceId, ...ch.msg, direction: "outbound" }),
    Message.countDocuments({
      workspaceId,
      ...ch.msg,
      direction: "outbound",
      sender: "bot",
    }),
    Message.countDocuments({ workspaceId, channelType: "instagram" }),
    Message.countDocuments({
      workspaceId,
      channelType: { $in: ["whatsapp", "wa"] },
    }),
    Contact.countDocuments({ workspaceId, isDeleted: false, ...ch.contact }),
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
  const ch = channelFilters(req);

  // Accept both the UI's names (week/month/3months) and legacy
  // daily/weekly/monthly so the period toggle actually changes the range.
  let groupFormat, startDate;
  switch (period) {
    case "daily":
      groupFormat = "%H:00";
      startDate = moment().startOf("day").toDate();
      break;
    case "month":
    case "monthly":
      groupFormat = "%Y-%m-%d";
      startDate = moment().subtract(30, "days").startOf("day").toDate();
      break;
    case "3months":
      groupFormat = "%Y-%m-%d";
      startDate = moment().subtract(90, "days").startOf("day").toDate();
      break;
    default: // week / weekly
      groupFormat = "%Y-%m-%d";
      startDate = moment().subtract(7, "days").startOf("day").toDate();
  }

  const raw = await Message.aggregate([
    { $match: { workspaceId, ...ch.msg, createdAt: { $gte: startDate } } },
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

  // Normalize keys the chart expects: `date`, `count` (total), plus the
  // inbound/outbound split for anyone who wants it.
  const data = raw.map((d) => ({
    date: d._id,
    count: (d.inbound || 0) + (d.outbound || 0),
    inbound: d.inbound || 0,
    outbound: d.outbound || 0,
  }));

  res.json({ success: true, data, period });
});

// @GET /api/analytics/peak-hours — Heatmap data
const getPeakHours = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const ch = channelFilters(req);
  const thirtyDaysAgo = moment().subtract(30, "days").toDate();

  const data = await Message.aggregate([
    {
      $match: {
        workspaceId,
        ...ch.msg,
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
  const c = (req.query.channel || "").toLowerCase();
  const filter = { workspaceId: req.workspace._id, status: "active" };
  if (c === "instagram") filter.channel = "instagram";
  else if (c === "whatsapp" || c === "wa")
    filter.channel = { $in: ["whatsapp", "wa"] };
  const flows = await Flow.find(filter)
    .select("name stats")
    .sort({ "stats.totalTriggers": -1 })
    .limit(10);

  res.json({ success: true, flows });
});

// @GET /api/analytics/contacts-growth — Contact growth trend
const getContactsGrowth = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const ch = channelFilters(req);
  const thirtyDaysAgo = moment().subtract(30, "days").toDate();

  const data = await Contact.aggregate([
    {
      $match: {
        workspaceId,
        isDeleted: false,
        ...ch.contact,
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
