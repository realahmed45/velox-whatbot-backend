const { Queue, Worker } = require("bullmq");
const { getRedisClient } = require("../config/redis");
const logger = require("../utils/logger");

let broadcastQueue = null;
let usageResetQueue = null;

const initQueues = () => {
  try {
    const redisClient = getRedisClient();
    if (!redisClient) {
      logger.warn("Redis not available — background jobs disabled");
      return;
    }

    const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
    const connection = new (require("ioredis"))(redisUrl, {
      maxRetriesPerRequest: null,
      tls: redisUrl.startsWith("rediss://") ? {} : undefined,
    });

    broadcastQueue = new Queue("broadcasts", { connection });
    usageResetQueue = new Queue("usage-reset", { connection });

    // Register workers
    require("./broadcastJob")(connection);
    require("./usageResetJob")(connection);
    require("./igTokenRefreshJob")(connection);

    // Initialize webhook retry queue
    const { initWebhookQueue } = require("../services/webhookDispatcher");
    initWebhookQueue();

    logger.info(
      "BullMQ queues initialized (broadcasts, usage-reset, webhooks)",
    );
  } catch (err) {
    logger.warn(
      `BullMQ init failed: ${err.message} — continuing without background jobs`,
    );
  }
};

const getBroadcastQueue = () => broadcastQueue;
const getUsageResetQueue = () => usageResetQueue;

module.exports = { initQueues, getBroadcastQueue, getUsageResetQueue };
