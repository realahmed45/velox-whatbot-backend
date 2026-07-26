const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const mailchimp = require("../services/mailchimpService");
const { encrypt, decrypt } = require("../utils/encryption");

// ─── Mailchimp ──────────────────────────────────────────────────────────────

// GET /api/integrations/mailchimp
exports.getMailchimp = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id);
  const m = ws?.integrations?.mailchimp || {};
  res.json({
    success: true,
    mailchimp: {
      connected: !!m.apiKey,
      listId: m.listId || null,
      serverPrefix: m.serverPrefix || null,
      connectedAt: m.connectedAt || null,
    },
  });
});

// POST /api/integrations/mailchimp  { apiKey?, listId? }
exports.connectMailchimp = asyncHandler(async (req, res) => {
  const { apiKey, listId } = req.body;
  const wsId = req.workspace._id;

  // If no apiKey provided, treat as list selection update for an existing connection
  if (!apiKey) {
    const existing = await Workspace.findById(wsId).select(
      "+integrations.mailchimp.apiKey",
    );
    if (!existing?.integrations?.mailchimp?.apiKey) {
      res.status(400);
      throw new Error("apiKey required");
    }
    await Workspace.findByIdAndUpdate(wsId, {
      "integrations.mailchimp.listId": listId || null,
    });
    return res.json({ success: true, updated: "listId" });
  }

  const test = await mailchimp.testConnection(apiKey);
  if (!test.ok) {
    res.status(400);
    throw new Error(test.error || "Mailchimp connection failed");
  }
  const serverPrefix = apiKey.split("-")[1];
  await Workspace.findByIdAndUpdate(wsId, {
    "integrations.mailchimp.apiKey": encrypt(apiKey),
    "integrations.mailchimp.listId": listId || null,
    "integrations.mailchimp.serverPrefix": serverPrefix,
    "integrations.mailchimp.connectedAt": new Date(),
  });
  res.json({ success: true, health: test.health });
});

// GET /api/integrations/mailchimp/lists
exports.listMailchimpAudiences = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select(
    "+integrations.mailchimp.apiKey",
  );
  const m = ws?.integrations?.mailchimp;
  if (!m?.apiKey) {
    res.status(400);
    throw new Error("Mailchimp not connected");
  }
  const lists = await mailchimp.listAudiences(
    decrypt(m.apiKey),
    m.serverPrefix,
  );
  res.json({ success: true, lists });
});

// POST /api/integrations/mailchimp/subscribe  { email, firstName?, lastName?, tags? }
exports.mailchimpSubscribe = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select(
    "+integrations.mailchimp.apiKey",
  );
  const m = ws?.integrations?.mailchimp;
  if (!m?.apiKey || !m?.listId) {
    res.status(400);
    throw new Error("Mailchimp not connected or list not selected");
  }
  const result = await mailchimp.subscribe(
    decrypt(m.apiKey),
    m.serverPrefix,
    m.listId,
    req.body,
  );
  if (!result.ok) {
    res.status(400);
    throw new Error(result.error || "Mailchimp subscribe failed");
  }
  res.json({ success: true, duplicate: result.duplicate || false });
});

// DELETE /api/integrations/mailchimp
exports.disconnectMailchimp = asyncHandler(async (req, res) => {
  await Workspace.findByIdAndUpdate(req.workspace._id, {
    "integrations.mailchimp": {},
  });
  res.json({ success: true });
});
