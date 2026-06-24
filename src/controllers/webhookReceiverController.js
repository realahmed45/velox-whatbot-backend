/**
 * Botlify — Inbound Webhook Receiver
 * Receive webhooks from Make.com, Zapier, or custom integrations
 * Trigger flows, send DMs, update contacts, etc.
 */
const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const Flow = require("../models/Flow");
const Contact = require("../models/Contact");
const { decrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

// POST /api/webhooks/inbound
exports.receiveWebhook = asyncHandler(async (req, res) => {
  const { workspaceId, action, data } = req.body;

  if (!workspaceId || !action) {
    return res.status(400).json({
      success: false,
      error: "workspaceId and action are required",
    });
  }

  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) {
    return res
      .status(404)
      .json({ success: false, error: "Workspace not found" });
  }

  logger.info(`[webhook-inbound] ${action} for workspace ${workspaceId}`);

  // ✅ Trigger Flow
  if (action === "trigger_flow") {
    const { flowId, contactId, contactInstagramId, variables } = data;

    if (!flowId) {
      return res.status(400).json({ success: false, error: "flowId required" });
    }

    const flow = await Flow.findOne({
      _id: flowId,
      workspaceId,
      status: "active",
    });

    if (!flow) {
      return res
        .status(404)
        .json({ success: false, error: "Flow not found or inactive" });
    }

    // Find or create contact
    let contact;
    if (contactId) {
      contact = await Contact.findOne({ _id: contactId, workspaceId });
    } else if (contactInstagramId) {
      contact = await Contact.findOne({
        workspaceId,
        instagramId: contactInstagramId,
      });
      if (!contact) {
        contact = await Contact.create({
          workspaceId,
          instagramId: contactInstagramId,
          username: contactInstagramId,
          source: "webhook",
        });
      }
    }

    if (!contact) {
      return res.status(400).json({
        success: false,
        error: "Contact not found. Provide contactId or contactInstagramId",
      });
    }

    // Execute flow via automation engine
    const { executeFlow } = require("../services/instagram/automationEngine");
    const result = await executeFlow(workspace, flow, contact, variables || {});

    return res.json({
      success: true,
      flowId: flow._id,
      contactId: contact._id,
      result,
    });
  }

  // ✅ Send DM
  if (action === "send_dm") {
    const { recipientId, recipientUsername, message, mediaUrl } = data;

    if (!message) {
      return res
        .status(400)
        .json({ success: false, error: "message required" });
    }

    // Find contact
    let contact;
    if (recipientId) {
      contact = await Contact.findOne({ _id: recipientId, workspaceId });
    } else if (recipientUsername) {
      contact = await Contact.findOne({
        workspaceId,
        username: recipientUsername,
      });
    }

    if (!contact || !contact.instagramId) {
      return res.status(404).json({
        success: false,
        error:
          "Contact not found. Provide valid recipientId or recipientUsername",
      });
    }

    // Send DM via Instagram service
    const { sendMessage } = require("../services/instagram/botlifyIgService");
    const wsWithToken = await Workspace.findById(workspace._id).select(
      "+instagram.accessToken",
    );

    if (!wsWithToken?.instagram?.accessToken) {
      return res.status(400).json({
        success: false,
        error: "Instagram not connected",
      });
    }

    const accessToken = decrypt(wsWithToken.instagram.accessToken);

    const result = await sendMessage(accessToken, contact.instagramId, {
      text: message,
      mediaUrl: mediaUrl || null,
    });

    return res.json({
      success: result?.success || false,
      message: "DM sent",
      contactId: contact._id,
    });
  }

  // ✅ Update Contact
  if (action === "update_contact") {
    const { contactId, contactInstagramId, updates } = data;

    if (!updates || typeof updates !== "object") {
      return res
        .status(400)
        .json({ success: false, error: "updates object required" });
    }

    let contact;
    if (contactId) {
      contact = await Contact.findOne({ _id: contactId, workspaceId });
    } else if (contactInstagramId) {
      contact = await Contact.findOne({
        workspaceId,
        instagramId: contactInstagramId,
      });
    }

    if (!contact) {
      return res
        .status(404)
        .json({ success: false, error: "Contact not found" });
    }

    // Update allowed fields
    const allowedFields = [
      "name",
      "email",
      "phone",
      "customFields",
      "tags",
      "notes",
    ];
    Object.keys(updates).forEach((key) => {
      if (allowedFields.includes(key)) {
        if (key === "tags" && Array.isArray(updates.tags)) {
          contact.tags = [...new Set([...contact.tags, ...updates.tags])];
        } else if (
          key === "customFields" &&
          typeof updates.customFields === "object"
        ) {
          contact.customFields = {
            ...contact.customFields,
            ...updates.customFields,
          };
        } else {
          contact[key] = updates[key];
        }
      }
    });

    await contact.save();

    return res.json({
      success: true,
      contactId: contact._id,
      message: "Contact updated",
    });
  }

  // ✅ Add Tag to Contact
  if (action === "add_tag") {
    const { contactId, contactInstagramId, tag } = data;

    if (!tag) {
      return res.status(400).json({ success: false, error: "tag required" });
    }

    let contact;
    if (contactId) {
      contact = await Contact.findOne({ _id: contactId, workspaceId });
    } else if (contactInstagramId) {
      contact = await Contact.findOne({
        workspaceId,
        instagramId: contactInstagramId,
      });
    }

    if (!contact) {
      return res
        .status(404)
        .json({ success: false, error: "Contact not found" });
    }

    if (!contact.tags.includes(tag)) {
      contact.tags.push(tag);
      await contact.save();
    }

    // Dispatch webhook event
    const { dispatchEvent } = require("../services/webhookDispatcher");
    await dispatchEvent(workspaceId, "contact.tagged", {
      contactId: contact._id,
      tag,
    });

    return res.json({
      success: true,
      contactId: contact._id,
      tag,
    });
  }

  // Unknown action
  res.status(400).json({
    success: false,
    error: `Unknown action: ${action}. Supported: trigger_flow, send_dm, update_contact, add_tag`,
  });
});

// POST /api/webhooks/shopify/inbound — Shopify webhook receiver
exports.receiveShopifyWebhook = asyncHandler(async (req, res) => {
  const shopDomain = req.get("X-Shopify-Shop-Domain");
  const topic = req.get("X-Shopify-Topic");
  const hmac = req.get("X-Shopify-Hmac-Sha256");

  if (!shopDomain || !topic) {
    return res.status(400).json({ error: "Missing Shopify headers" });
  }

  // Verify HMAC signature
  if (process.env.SHOPIFY_API_SECRET && hmac) {
    const crypto = require("crypto");
    const hash = crypto
      .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(req.rawBody || JSON.stringify(req.body), "utf8")
      .digest("base64");

    if (hash !== hmac) {
      logger.warn(`[shopify-webhook] Invalid HMAC from ${shopDomain}`);
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const webhookData = req.body;
  logger.info(`[shopify-webhook] ${topic} from ${shopDomain}`);

  // Find workspace connected to this shop
  const workspace = await Workspace.findOne({
    "integrations.shopify.storeUrl": shopDomain,
  });

  if (!workspace) {
    logger.warn(`[shopify-webhook] No workspace for ${shopDomain}`);
    return res.status(200).json({ message: "No workspace found" });
  }

  // Handle different webhook topics
  if (topic === "products/update") {
    // Product updated — could invalidate cache
    logger.info(`[shopify-webhook] Product updated in ${shopDomain}`);
  } else if (topic === "orders/paid") {
    // Order paid — dispatch to user's webhooks
    const { dispatchEvent } = require("../services/webhookDispatcher");
    await dispatchEvent(workspace._id, "shopify.order.paid", webhookData);
  } else if (topic === "customers/create") {
    // New customer — could auto-create contact
    const { email, first_name, last_name } = webhookData;
    logger.info(`[shopify-webhook] New customer: ${email}`);
  }

  res.status(200).json({ message: "Webhook processed" });
});

module.exports = {
  receiveWebhook,
  receiveShopifyWebhook,
};
