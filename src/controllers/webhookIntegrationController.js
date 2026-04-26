/**
 * Botlify — Webhook Integrations Controller (CRM / Zapier outbound)
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const WebhookIntegration = require("../models/WebhookIntegration");

exports.list = asyncHandler(async (req, res) => {
  const items = await WebhookIntegration.find({
    workspaceId: req.workspace._id,
  })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, integrations: items });
});

exports.create = asyncHandler(async (req, res) => {
  const { name, url, events } = req.body;
  if (!name || !url) {
    return res.status(400).json({ message: "name and url are required" });
  }
  const secret = crypto.randomBytes(24).toString("hex");
  const item = await WebhookIntegration.create({
    workspaceId: req.workspace._id,
    name,
    url,
    secret,
    events: Array.isArray(events) && events.length ? events : undefined,
  });
  res.status(201).json({ success: true, integration: item });
});

exports.update = asyncHandler(async (req, res) => {
  const { name, url, events, enabled } = req.body;
  const item = await WebhookIntegration.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { $set: { name, url, events, enabled } },
    { new: true },
  );
  if (!item) return res.status(404).json({ message: "Not found" });
  res.json({ success: true, integration: item });
});

exports.remove = asyncHandler(async (req, res) => {
  await WebhookIntegration.deleteOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  res.json({ success: true });
});

exports.test = asyncHandler(async (req, res) => {
  const item = await WebhookIntegration.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!item) return res.status(404).json({ message: "Not found" });
  const { fireWebhook } = require("../services/webhookDispatcher");
  const result = await fireWebhook(item, "test.event", {
    message: "Hello from Botlify",
    workspaceId: req.workspace._id,
  });
  res.json({ success: true, result });
});
