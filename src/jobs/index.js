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

    const connection = {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
    };

    broadcastQueue = new Queue("broadcasts", { connection });
    usageResetQueue = new Queue("usage-reset", { connection });

    // Register workers
    require("./broadcastJob")(connection);
    require("./usageResetJob")(connection);

    logger.info("BullMQ queues initialized");
  } catch (err) {
    logger.warn(
      `BullMQ init failed: ${err.message} — continuing without background jobs`,
    );
  }
};

const getBroadcastQueue = () => broadcastQueue;
const getUsageResetQueue = () => usageResetQueue;

module.exports = { initQueues, getBroadcastQueue, getUsageResetQueue };
