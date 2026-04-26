/**
 * Botlify — Giveaway Controller
 */
const asyncHandler = require("express-async-handler");
const Giveaway = require("../models/Giveaway");

exports.list = asyncHandler(async (req, res) => {
  const items = await Giveaway.find({ workspaceId: req.workspace._id })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, giveaways: items });
});

exports.get = asyncHandler(async (req, res) => {
  const g = await Giveaway.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!g) return res.status(404).json({ message: "Not found" });
  res.json({ success: true, giveaway: g });
});

exports.create = asyncHandler(async (req, res) => {
  const {
    title,
    prize,
    postId,
    postUrl,
    entryKeyword,
    requireFollow,
    requireTag,
    startsAt,
    endsAt,
    maxWinners,
    winnerDmMessage,
  } = req.body;
  if (!title || !postId || !endsAt) {
    return res
      .status(400)
      .json({ message: "title, postId and endsAt are required" });
  }
  const g = await Giveaway.create({
    workspaceId: req.workspace._id,
    title,
    prize,
    postId,
    postUrl,
    entryKeyword,
    requireFollow: !!requireFollow,
    requireTag: !!requireTag,
    startsAt: startsAt ? new Date(startsAt) : new Date(),
    endsAt: new Date(endsAt),
    maxWinners: Math.max(1, parseInt(maxWinners) || 1),
    winnerDmMessage,
    status: "active",
  });
  res.status(201).json({ success: true, giveaway: g });
});

exports.update = asyncHandler(async (req, res) => {
  const g = await Giveaway.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    req.body,
    { new: true },
  );
  if (!g) return res.status(404).json({ message: "Not found" });
  res.json({ success: true, giveaway: g });
});

exports.remove = asyncHandler(async (req, res) => {
  await Giveaway.deleteOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  res.json({ success: true });
});

// Pick random winner(s) — can be triggered manually before endsAt
exports.pickWinners = asyncHandler(async (req, res) => {
  const g = await Giveaway.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!g) return res.status(404).json({ message: "Not found" });

  const pool = g.participants.filter(
    (p) => !g.winners.some((w) => w.igUserId === p.igUserId),
  );
  if (pool.length === 0) {
    return res.status(400).json({ message: "No participants to pick from" });
  }
  const count = Math.min(g.maxWinners - g.winners.length, pool.length);
  const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, count);
  for (const p of shuffled) {
    g.winners.push({
      igUserId: p.igUserId,
      igUsername: p.igUsername,
      pickedAt: new Date(),
    });
  }
  if (g.winners.length >= g.maxWinners) g.status = "completed";
  await g.save();
  res.json({ success: true, giveaway: g });
});
