/**
 * Botlify — Inbound Webhook Routes
 * Public endpoints to receive webhooks from Make.com, Zapier, Shopify, etc.
 */
const express = require("express");
const router = express.Router();
const { webhookLimiter } = require("../middleware/enhancedRateLimiter");
const webhookReceiverController = require("../controllers/webhookReceiverController");

// Public webhook receiver (no auth required — use workspaceId in payload)
router.post(
  "/inbound",
  webhookLimiter,
  webhookReceiverController.receiveWebhook,
);

// Shopify webhook receiver (public, verified by HMAC)
router.post(
  "/shopify/inbound",
  webhookLimiter,
  webhookReceiverController.receiveShopifyWebhook,
);

module.exports = router;
