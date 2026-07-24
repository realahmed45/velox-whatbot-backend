const ScheduledPost = require("../models/ScheduledPost");
const Workspace = require("../models/Workspace");
const { publishPost, publishStory } = require("../services/instagram");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

/**
 * Process all scheduled posts that are due to be published
 * Runs every 5 minutes via cron
 */
const processScheduledPosts = async () => {
  const now = new Date();

  try {
    // Fallback: posts accepted by the provider but never confirmed via a
    // post.published/post.failed webhook within 10 minutes are promoted to
    // "published" so they don't sit in "publishing" forever. (Zernio almost
    // always publishes; a missing webhook shouldn't strand the post.)
    await ScheduledPost.updateMany(
      {
        status: "publishing",
        submittedAt: { $lte: new Date(now.getTime() - 10 * 60 * 1000) },
      },
      { $set: { status: "published", publishedAt: now } },
    );

    // Find all posts that are:
    // - status: pending
    // - scheduledTime <= now (overdue or exactly on time)
    const duePosts = await ScheduledPost.find({
      status: "pending",
      scheduledTime: { $lte: now },
    }).limit(50); // Process max 50 at a time to avoid overwhelming the system

    if (duePosts.length === 0) {
      return;
    }

    logger.info(`[ScheduledPosts] Processing ${duePosts.length} posts`);

    for (const post of duePosts) {
      try {
        // Mark as publishing to prevent duplicate processing
        post.status = "publishing";
        await post.save();

        // Get workspace with decrypted credentials
        const workspace = await Workspace.findById(post.workspaceId).select(
          "+instagram.accessToken +instagram.igUserId",
        );

        if (
          !workspace ||
          workspace.instagram?.status !== "connected" ||
          !workspace.instagram.accessToken
        ) {
          post.status = "failed";
          post.errorMessage = "Instagram not connected to workspace";
          await post.save();
          logger.warn(
            `[ScheduledPosts] Post ${post._id}: Instagram not connected`,
          );
          continue;
        }

        const accessToken = decrypt(workspace.instagram.accessToken);
        const igUserId = decrypt(workspace.instagram.igUserId);

        // Publish to Instagram (story or feed image)
        const result =
          post.postType === "story"
            ? await publishStory(accessToken, igUserId, post.imageUrl)
            : await publishPost(
                accessToken,
                igUserId,
                post.imageUrl,
                post.caption,
              );

        if (result.success) {
          // Zernio ACCEPTED the post but publishes to Instagram asynchronously.
          // Mark it "publishing" (queued) and let the post.published / post.failed
          // webhook flip it to the real final status. If no webhook arrives, a
          // sweep below promotes long-pending ones to published as a fallback.
          post.status = "publishing";
          post.publishedPostId = result.mediaId;
          post.submittedAt = new Date();
          await post.save();
          logger.info(
            `[ScheduledPosts] Post ${post._id} accepted by provider (queued): ${result.mediaId}`,
          );

          // If this was a recurring post, schedule the next occurrence
          if (post.recurring?.enabled) {
            await scheduleNextRecurrence(post);
          }
        } else {
          post.status = "failed";
          post.errorMessage = result.error || "Unknown error";
          await post.save();
          logger.error(
            `[ScheduledPosts] Post ${post._id} failed: ${result.error}`,
          );
        }
      } catch (err) {
        post.status = "failed";
        post.errorMessage = err.message;
        await post.save();
        logger.error(`[ScheduledPosts] Post ${post._id} error:`, err);
      }
    }

    logger.info(
      `[ScheduledPosts] Batch complete: ${duePosts.length} posts processed`,
    );
  } catch (err) {
    logger.error("[ScheduledPosts] Job error:", err);
  }
};

/**
 * Compute the next run time for a recurring post.
 */
const computeNextRun = (recurring, from = new Date()) => {
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(recurring.hour ?? 9, recurring.minute ?? 0, 0, 0);

  if (recurring.frequency === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  if (recurring.frequency === "weekly") {
    const days = recurring.daysOfWeek?.length
      ? [...recurring.daysOfWeek].sort((a, b) => a - b)
      : [next.getDay()];
    for (let i = 0; i < 14; i++) {
      const candidate = new Date(next);
      candidate.setDate(next.getDate() + i);
      if (days.includes(candidate.getDay()) && candidate > from)
        return candidate;
    }
  }
  if (recurring.frequency === "monthly") {
    if (next <= from) next.setMonth(next.getMonth() + 1);
    return next;
  }
  // fallback: +1 week
  next.setDate(next.getDate() + 7);
  return next;
};

/**
 * After a recurring post publishes, create the next scheduled occurrence.
 */
const scheduleNextRecurrence = async (post) => {
  const r = post.recurring || {};
  const newOccurrences = (r.occurrences || 0) + 1;
  if (r.maxOccurrences && newOccurrences >= r.maxOccurrences) return;

  const nextRun = computeNextRun(r, new Date());
  await ScheduledPost.create({
    workspaceId: post.workspaceId,
    channelType: post.channelType,
    imageUrl: post.imageUrl,
    caption: post.caption,
    scheduledTime: nextRun,
    status: "pending",
    recurring: {
      enabled: true,
      frequency: r.frequency,
      daysOfWeek: r.daysOfWeek,
      hour: r.hour,
      minute: r.minute,
      maxOccurrences: r.maxOccurrences,
      occurrences: newOccurrences,
      parentId: r.parentId || post._id,
    },
  });
};

module.exports = { processScheduledPosts };
