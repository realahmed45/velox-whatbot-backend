/**
 * Botlify — Outbound webhook dispatcher (CRM / Zapier / custom URLs)
 */
const crypto = require("crypto");
const logger = require("../utils/logger");
const WebhookIntegration = require("../models/WebhookIntegration");

const sign = (secret, body) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

const fireWebhook = async (integration, eventName, payload) => {
  if (!integration?.enabled || !integration.url) return { skipped: true };
  const body = JSON.stringify({
    event: eventName,
    workspaceId: integration.workspaceId,
    timestamp: new Date().toISOString(),
    data: payload,
  });
  const headers = { "Content-Type": "application/json" };
  if (integration.secret) {
    headers["X-Botlify-Signature"] = sign(integration.secret, body);
  }
  try {
    const res = await fetch(integration.url, { method: "POST", headers, body });
    integration.lastFiredAt = new Date();
    integration.lastStatus = `${res.status}`;
    if (res.status >= 400) {
      integration.failureCount = (integration.failureCount || 0) + 1;
      integration.lastError = `HTTP ${res.status}`;
    } else {
      integration.failureCount = 0;
      integration.lastError = null;
    }
    await integration.save();
    return { ok: res.ok, status: res.status };
  } catch (err) {
    integration.failureCount = (integration.failureCount || 0) + 1;
    integration.lastError = err.message;
    integration.lastStatus = "error";
    integration.lastFiredAt = new Date();
    await integration.save();
    logger.warn(`[webhook] ${integration.name} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

const dispatchEvent = async (workspaceId, eventName, payload) => {
  try {
    const hooks = await WebhookIntegration.find({
      workspaceId,
      enabled: true,
      events: eventName,
    });
    await Promise.all(hooks.map((h) => fireWebhook(h, eventName, payload)));
  } catch (err) {
    logger.warn(`[webhook] dispatch ${eventName} error: ${err.message}`);
  }
};

module.exports = { fireWebhook, dispatchEvent };
