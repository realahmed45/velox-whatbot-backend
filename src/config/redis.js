const Redis = require("ioredis");
const logger = require("../utils/logger");

let redisClient;

const getRedisClient = () => {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      tls:
        process.env.REDIS_URL && process.env.REDIS_URL.startsWith("rediss://")
          ? {}
          : undefined,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
    redisClient.on("connect", () => logger.info("Redis connected"));
    redisClient.on("error", (err) =>
      logger.error(`Redis error: ${err.message}`),
    );
  }
  return redisClient;
};

module.exports = { getRedisClient };
