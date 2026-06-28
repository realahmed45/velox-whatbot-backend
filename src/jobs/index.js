const { Queue, Worker } = require("bullmq");
const { getRedisClient } = require("../config/redis");
const logger = require("../utils/logger");

let broadcastQueue = null;
let usageResetQueue = null;

// Shared worker options — dramatically reduces Redis polling to save Upstash request quota.
// stalledInterval: how often (ms) BullMQ checks for stalled jobs (default 5000ms → we use 300000ms = 5min)
// lockDuration: how long a job lock lasts (default 30000ms → we use 600000ms = 10min)
const WORKER_DEFAULTS = {
  stalledInterval: 300_000,  // 5 minutes (default: 5s) — cuts stall-check Redis calls by 60x
  lockDuration: 600_000,     // 10 minutes
  maxStalledCount: 1,
};

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
      enableOfflineQueue: false,
      tls: redisUrl.startsWith("rediss://") ? {} : undefined,
    });

    broadcastQueue = new Queue("broadcasts", { connection });
    usageResetQueue = new Queue("usage-reset", { connection });

    // Register workers — pass WORKER_DEFAULTS to reduce Redis ops
    require("./broadcastJob")(connection, WORKER_DEFAULTS);
    require("./usageResetJob")(connection, WORKER_DEFAULTS);
    require("./igTokenRefreshJob")(connection, WORKER_DEFAULTS);

    // Initialize webhook retry queue
    const { initWebhookQueue } = require("../services/webhookDispatcher");
    initWebhookQueue(WORKER_DEFAULTS);

    logger.info(
      "BullMQ queues initialized (broadcasts, usage-reset, webhooks) with reduced Redis polling",
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
