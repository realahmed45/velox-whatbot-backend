const Redis = require("ioredis");
const logger = require("../utils/logger");

/**
 * Resolve Redis connection options robustly.
 *
 * Supports EITHER:
 *   - REDIS_URL = redis://user:pass@host:port  (or rediss:// for TLS)
 *   - separate REDIS_HOST / REDIS_PORT / REDIS_PASSWORD [/ REDIS_TLS=true]
 *
 * A malformed REDIS_URL (e.g. missing host:port, a stray trailing char) used to
 * throw "Invalid port in url" and take down queue init. We now VALIDATE the URL
 * and fall back to the discrete vars or localhost instead of crashing.
 *
 * @returns {object|null} ioredis options object, or null when nothing usable is
 *   configured (caller should run without Redis).
 */
function resolveRedisConfig() {
  const url = (process.env.REDIS_URL || "").trim();

  if (url) {
    try {
      const u = new URL(url);
      const port = u.port ? Number(u.port) : 6379;
      if (!u.hostname || Number.isNaN(port)) {
        throw new Error("missing host or port");
      }
      return {
        host: u.hostname,
        port,
        username: u.username || undefined,
        password: decodeURIComponent(u.password || "") || undefined,
        tls: u.protocol === "rediss:" ? {} : undefined,
      };
    } catch (err) {
      logger.warn(
        `[redis] REDIS_URL is malformed (${err.message}); trying discrete REDIS_* vars`,
      );
      // fall through to discrete vars below
    }
  }

  // Discrete vars (Upstash / Redis Cloud often provide these).
  if (process.env.REDIS_HOST) {
    return {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT) || 6379,
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    };
  }

  // Nothing configured in production → signal "no Redis".
  if (process.env.NODE_ENV === "production") return null;

  // Local dev default.
  return { host: "127.0.0.1", port: 6379 };
}

/**
 * Build a fresh ioredis connection with our standard options (used by BullMQ,
 * which needs a dedicated connection per set of queues/workers).
 * @returns {Redis|null} null when Redis isn't configured.
 */
function createRedisConnection(extra = {}) {
  const cfg = resolveRedisConfig();
  if (!cfg) return null;
  const conn = new Redis({
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    ...cfg,
    ...extra,
  });
  conn.on("error", (err) => logger.error(`Redis error: ${err.message}`));
  return conn;
}

let redisClient;

/** Shared app-wide Redis client (lazy). Returns null when unconfigured. */
const getRedisClient = () => {
  if (redisClient) return redisClient;
  const conn = createRedisConnection();
  if (!conn) {
    logger.warn("[redis] not configured — running without Redis");
    return null;
  }
  conn.on("connect", () => logger.info("Redis connected"));
  redisClient = conn;
  return redisClient;
};

module.exports = { getRedisClient, createRedisConnection, resolveRedisConfig };
