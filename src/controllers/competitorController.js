/**
 * Botlify — Competitor Tracking Controller
 */
const asyncHandler = require("express-async-handler");
const Competitor = require("../models/Competitor");

exports.list = asyncHandler(async (req, res) => {
  const items = await Competitor.find({ workspaceId: req.workspace._id })
    .sort({ username: 1 })
    .lean();
  res.json({ success: true, competitors: items });
});

exports.create = asyncHandler(async (req, res) => {
  const { username, displayName, notes } = req.body;
  if (!username) return res.status(400).json({ message: "username required" });
  const clean = username.replace(/^@/, "").toLowerCase().trim();
  try {
    const c = await Competitor.create({
      workspaceId: req.workspace._id,
      username: clean,
      displayName,
      notes,
    });
    res.status(201).json({ success: true, competitor: c });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Competitor already tracked" });
    }
    throw err;
  }
});

exports.remove = asyncHandler(async (req, res) => {
  await Competitor.deleteOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  res.json({ success: true });
});

exports.addSnapshot = asyncHandler(async (req, res) => {
  const { followers, following, mediaCount, engagementRate } = req.body;
  const c = await Competitor.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!c) return res.status(404).json({ message: "Not found" });
  c.snapshots.push({
    date: new Date(),
    followers,
    following,
    mediaCount,
    engagementRate,
  });
  // Keep last 90 snapshots only
  if (c.snapshots.length > 90) c.snapshots = c.snapshots.slice(-90);
  c.lastSyncedAt = new Date();
  await c.save();
  res.json({ success: true, competitor: c });
});
