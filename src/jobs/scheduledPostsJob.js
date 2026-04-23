const ScheduledPost = require("../models/ScheduledPost");
const Workspace = require("../models/Workspace");
const { publishPost } = require("../services/instagram/metaService");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

/**
 * Process all scheduled posts that are due to be published
 * Runs every 5 minutes via cron
 */
const processScheduledPosts = async () => {
  const now = new Date();

  try {
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

        // Publish to Instagram
        const result = await publishPost(
          accessToken,
          igUserId,
          post.imageUrl,
          post.caption,
        );

        if (result.success) {
          post.status = "published";
          post.publishedAt = new Date();
          post.publishedPostId = result.mediaId;
          await post.save();
          logger.info(
            `[ScheduledPosts] Post ${post._id} published successfully: ${result.mediaId}`,
          );
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

module.exports = { processScheduledPosts };
