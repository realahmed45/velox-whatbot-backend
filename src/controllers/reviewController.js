/**
 * reviewController — dashboard-side reputation management.
 *
 *   GET   /api/growth/reviews             → list (filters: needsReply, limit)
 *   POST  /api/growth/reviews/:id/draft   → AI-draft a reply
 *   PATCH /api/growth/reviews/:id/reply   → approve (with edits) or skip
 *   GET   /api/growth/reviews/themes      → recurring complaints
 *
 * Replies are NEVER auto-posted — the owner approves every one.
 */
const asyncHandler = require("express-async-handler");
const Review = require("../models/Review");
const {
  draftReply,
  approveReply,
  skipReply,
  summarizeThemes,
} = require("../services/reputation/reviewService");

// @GET / — newest first. needsReply=true → only the ones still awaiting action.
const list = asyncHandler(async (req, res) => {
  const { needsReply } = req.query;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  const q = { workspaceId: req.workspace._id };
  if (needsReply === "true" || needsReply === "1") {
    q["reply.status"] = { $in: ["none", "drafted"] };
  }

  const reviews = await Review.find(q)
    .sort({ reviewedAt: -1 })
    .limit(limit)
    .lean();
  res.json({ success: true, reviews });
});

// @GET /themes — what guests keep complaining about.
const themes = asyncHandler(async (req, res) => {
  const result = await summarizeThemes(req.workspace._id);
  res.json({
    success: true,
    themes: result.themes,
    reviewCount: result.reviewCount,
  });
});

// @POST /:id/draft — generate a reply draft with the AI.
const draft = asyncHandler(async (req, res) => {
  const review = await Review.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!review) {
    res.status(404);
    throw new Error("Review not found");
  }

  const result = await draftReply(review);
  if (!result.ok) {
    res.status(result.reason === "ai_unavailable" ? 503 : 400);
    throw new Error(
      result.reason === "ai_unavailable"
        ? "The AI is unavailable right now — try again shortly"
        : `Could not draft a reply (${result.reason})`,
    );
  }

  res.json({ success: true, review: result.review, draft: result.draft });
});

// @PATCH /:id/reply — approve the draft (optionally edited) or skip it.
const updateReply = asyncHandler(async (req, res) => {
  const { text, action } = req.body || {};
  if (!["approve", "skip"].includes(action)) {
    res.status(400);
    throw new Error("action must be 'approve' or 'skip'");
  }

  const review = await Review.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!review) {
    res.status(404);
    throw new Error("Review not found");
  }

  const result =
    action === "approve"
      ? await approveReply(review._id, text)
      : await skipReply(review._id);

  if (!result.ok) {
    res.status(400);
    throw new Error(
      result.reason === "no_draft"
        ? "There's no reply text to approve — draft one first or send your own text"
        : `Could not update that reply (${result.reason})`,
    );
  }

  res.json({ success: true, review: result.review });
});

module.exports = { list, themes, draft, updateReply };
