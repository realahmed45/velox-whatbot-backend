const asyncHandler = require("express-async-handler");
const ScheduledPost = require("../models/ScheduledPost");
const Workspace = require("../models/Workspace");
const Message = require("../models/Message");
const { decrypt } = require("../utils/encryption");
const moment = require("moment");

/**
 * GET /api/scheduled-posts
 * List all scheduled posts for the workspace
 */
exports.getScheduledPosts = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const { status, page = 1, limit = 20 } = req.query;

  const query = { workspaceId };
  if (status) {
    query.status = status;
  }

  const posts = await ScheduledPost.find(query)
    .sort({ scheduledTime: 1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

  const total = await ScheduledPost.countDocuments(query);

  res.json({
    success: true,
    posts,
    total,
    page: parseInt(page),
    pages: Math.ceil(total / limit),
  });
});

/**
 * POST /api/scheduled-posts
 * Create a new scheduled post
 * Body: { imageUrl, caption, scheduledTime }
 */
exports.createScheduledPost = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const { imageUrl, caption, scheduledTime } = req.body;

  if (!imageUrl || !scheduledTime) {
    return res
      .status(400)
      .json({ message: "imageUrl and scheduledTime are required" });
  }

  // Validate scheduledTime is in the future
  const scheduleDate = new Date(scheduledTime);
  if (scheduleDate <= new Date()) {
    return res
      .status(400)
      .json({ message: "scheduledTime must be in the future" });
  }

  // Verify workspace has Instagram connected
  const workspace = await Workspace.findById(workspaceId).select(
    "+instagram.accessToken +instagram.igUserId",
  );
  if (
    !workspace ||
    workspace.instagram?.status !== "connected" ||
    !workspace.instagram.accessToken
  ) {
    return res
      .status(400)
      .json({ message: "Instagram not connected to this workspace" });
  }

  const post = await ScheduledPost.create({
    workspaceId,
    channelType: "instagram",
    imageUrl,
    caption: caption || "",
    scheduledTime: scheduleDate,
    status: "pending",
  });

  res.status(201).json({
    success: true,
    post,
  });
});

/**
 * DELETE /api/scheduled-posts/:id
 * Cancel a scheduled post
 */
exports.cancelScheduledPost = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];
  const { id } = req.params;

  const post = await ScheduledPost.findOne({
    _id: id,
    workspaceId,
  });

  if (!post) {
    return res.status(404).json({ message: "Scheduled post not found" });
  }

  if (post.status === "published") {
    return res
      .status(400)
      .json({ message: "Cannot cancel a post that's already published" });
  }

  post.status = "cancelled";
  await post.save();

  res.json({
    success: true,
    message: "Scheduled post cancelled",
  });
});

/**
 * GET /api/scheduled-posts/smart-timing
 * Analyze best posting times based on past engagement
 * Returns recommended times to post for maximum engagement
 */
exports.getSmartTiming = asyncHandler(async (req, res) => {
  const workspaceId = req.headers["x-workspace-id"];

  // Analyze message patterns from last 30 days
  const thirtyDaysAgo = moment().subtract(30, "days").toDate();

  const messages = await Message.find({
    workspaceId,
    channelType: "instagram",
    direction: "inbound",
    createdAt: { $gte: thirtyDaysAgo },
  }).select("createdAt");

  if (messages.length < 10) {
    // Not enough data - return default recommendations
    return res.json({
      success: true,
      recommendations: [
        {
          dayOfWeek: "Monday-Friday",
          time: "18:00",
          score: 85,
          reason: "Default: Evening hours typically see highest engagement",
        },
        {
          dayOfWeek: "Saturday-Sunday",
          time: "12:00",
          score: 80,
          reason: "Default: Weekend midday engagement",
        },
      ],
      dataPoints: messages.length,
      message:
        "Using default recommendations - more data needed for personalization",
    });
  }

  // Analyze by hour of day
  const hourCounts = {};
  messages.forEach((msg) => {
    const hour = moment(msg.createdAt).hour();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
  });

  // Find top 3 hours with most activity
  const topHours = Object.entries(hourCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([hour, count]) => ({
      hour: parseInt(hour),
      count,
      score: Math.round((count / messages.length) * 100),
    }));

  const recommendations = topHours.map((h) => ({
    dayOfWeek: "Any day",
    time: moment().hour(h.hour).minute(0).format("HH:mm"),
    score: h.score,
    reason: `${h.count} messages received during this hour in the last 30 days`,
  }));

  res.json({
    success: true,
    recommendations,
    dataPoints: messages.length,
    message: "Personalized recommendations based on your audience activity",
  });
});
