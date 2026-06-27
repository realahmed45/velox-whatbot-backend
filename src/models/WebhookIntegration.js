/**
 * Botlify — CRM / Zapier Webhook Integration
 * Workspaces can register outbound webhooks to fire on events.
 */
const mongoose = require("mongoose");

const webhookIntegrationSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: { type: String, required: true },
    url: { type: String, required: true },
    secret: String, // optional HMAC signing key
    events: {
      type: [String],
      default: [
        "dm.received",
        "dm.sent",
        "comment.received",
        "lead.created",
        "flow.completed",
        "contact.tagged",
      ],
    },
    enabled: { type: Boolean, default: true },
    lastFiredAt: Date,
    lastStatus: String,
    lastError: String,
    failureCount: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model("WebhookIntegration", webhookIntegrationSchema);
