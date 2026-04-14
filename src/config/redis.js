const { createClient } = require("ioredis");
const logger = require("../utils/logger");

let redisClient;

const getRedisClient = () => {
  if (!redisClient) {
    redisClient = new createClient(
      process.env.REDIS_URL || "redis://localhost:6379",
      {
        maxRetriesPerRequest: null,
        retryStrategy: (times) => Math.min(times * 50, 2000),
      },
    );
    redisClient.on("connect", () => logger.info("Redis connected"));
    redisClient.on("error", (err) =>
      logger.error(`Redis error: ${err.message}`),
    );
  }
  return redisClient;
};

module.exports = { getRedisClient };
