/**
 * Botlify — Outbound webhook dispatcher (CRM / Zapier / custom URLs)
 * With BullMQ-powered retry mechanism and exponential backoff
 */
const crypto = require("crypto");
const { Queue, Worker } = require("bullmq");
const logger = require("../utils/logger");
const WebhookIntegration = require("../models/WebhookIntegration");

const sign = (secret, body) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

// Initialize webhook queue with retry support
let webhookQueue = null;
let webhookWorker = null;

const initWebhookQueue = () => {
  try {
    const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
    const connection = new (require("ioredis"))(redisUrl, {
      maxRetriesPerRequest: null,
      tls: redisUrl.startsWith("rediss://") ? {} : undefined,
    });

    webhookQueue = new Queue("webhook-delivery", { connection });

    // Worker to process webhook deliveries with automatic retries
    webhookWorker = new Worker(
      "webhook-delivery",
      async (job) => {
        const { integrationId, eventName, payload } = job.data;
        const integration = await WebhookIntegration.findById(integrationId);

        if (!integration) {
          logger.warn(`[webhook] Integration ${integrationId} not found`);
          return { skipped: true, reason: "integration_deleted" };
        }

        return await fireWebhookDirect(integration, eventName, payload);
      },
      {
        connection,
        concurrency: 5,
        limiter: {
          max: 100,
          duration: 1000,
        },
      },
    );

    webhookWorker.on("completed", (job) => {
      logger.info(`[webhook] Job ${job.id} completed`, job.returnvalue);
    });

    webhookWorker.on("failed", (job, err) => {
      logger.error(
        `[webhook] Job ${job?.id} failed after retries: ${err.message}`,
      );
    });

    logger.info("Webhook queue initialized with retry support");
  } catch (err) {
    logger.warn(
      `[webhook] Queue init failed: ${err.message} — using direct dispatch`,
    );
  }
};

// Direct webhook firing (used by worker)
const fireWebhookDirect = async (integration, eventName, payload) => {
  if (!integration?.enabled || !integration.url) return { skipped: true };

  const body = JSON.stringify({
    event: eventName,
    workspaceId: integration.workspaceId,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Botlify-Webhook/1.0",
  };

  if (integration.secret) {
    headers["X-Botlify-Signature"] = sign(integration.secret, body);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const res = await fetch(integration.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    integration.lastFiredAt = new Date();
    integration.lastStatus = `${res.status}`;

    if (res.status >= 400) {
      integration.failureCount = (integration.failureCount || 0) + 1;
      integration.lastError = `HTTP ${res.status}`;
      await integration.save();

      // Throw error to trigger retry
      throw new Error(`Webhook returned ${res.status}`);
    } else {
      integration.failureCount = 0;
      integration.lastError = null;
      integration.successCount = (integration.successCount || 0) + 1;
      await integration.save();
      return { ok: true, status: res.status };
    }
  } catch (err) {
    integration.failureCount = (integration.failureCount || 0) + 1;
    integration.lastError = err.message;
    integration.lastStatus = "error";
    integration.lastFiredAt = new Date();
    await integration.save();

    logger.warn(`[webhook] ${integration.name} failed: ${err.message}`);
    throw err; // Re-throw to trigger BullMQ retry
  }
};

// Legacy direct fire (for backwards compatibility)
const fireWebhook = async (integration, eventName, payload) => {
  try {
    return await fireWebhookDirect(integration, eventName, payload);
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

// Main dispatch function with queue support
const dispatchEvent = async (workspaceId, eventName, payload) => {
  try {
    const hooks = await WebhookIntegration.find({
      workspaceId,
      enabled: true,
      events: eventName,
    });

    if (!hooks || hooks.length === 0) return;

    // If queue available, use it for retry support
    if (webhookQueue) {
      for (const hook of hooks) {
        await webhookQueue.add(
          "fire",
          {
            integrationId: hook._id.toString(),
            eventName,
            payload,
          },
          {
            attempts: 3,
            backoff: {
              type: "exponential",
              delay: 60000, // Start with 1 minute
            },
            removeOnComplete: {
              age: 3600, // Keep for 1 hour
              count: 100,
            },
            removeOnFail: {
              age: 86400, // Keep failed for 24 hours
            },
          },
        );
      }
      logger.info(
        `[webhook] Queued ${hooks.length} webhooks for event: ${eventName}`,
      );
    } else {
      // Fallback to direct dispatch if queue not available
      await Promise.all(hooks.map((h) => fireWebhook(h, eventName, payload)));
      logger.info(
        `[webhook] Direct dispatched ${hooks.length} webhooks for event: ${eventName}`,
      );
    }
  } catch (err) {
    logger.error(`[webhook] dispatch ${eventName} error: ${err.message}`);
  }
};

module.exports = {
  fireWebhook,
  dispatchEvent,
  initWebhookQueue,
  fireWebhookDirect,
};
