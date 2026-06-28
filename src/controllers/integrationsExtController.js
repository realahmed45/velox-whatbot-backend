const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const shopify = require("../services/shopifyService");
const mailchimp = require("../services/mailchimpService");
const { encrypt, decrypt } = require("../utils/encryption");

// ─── Shopify ────────────────────────────────────────────────────────────────

// GET /api/integrations/shopify
exports.getShopify = asyncHandler(async (req, res) => {
  let ws = await Workspace.findById(req.workspace._id).select(
    "+integrations.shopify.accessToken",
  );
  let s = ws?.integrations?.shopify || {};

  // Back-fill scope status for stores connected before scope tracking existed.
  if (s.storeUrl && s.accessToken && !s.scopesCheckedAt) {
    try {
      const scopes = await shopify.verifyScopes(
        s.storeUrl,
        decrypt(s.accessToken),
      );
      await Workspace.findByIdAndUpdate(req.workspace._id, {
        "integrations.shopify.scopes": scopes,
        "integrations.shopify.scopesCheckedAt": new Date(),
      });
      s = { ...s, scopes, scopesCheckedAt: new Date() };
    } catch {
      /* keep cached state */
    }
  }

  res.json({
    success: true,
    shopify: {
      storeUrl: s.storeUrl || null,
      connected: !!s.storeUrl,
      connectedAt: s.connectedAt || null,
      productCount: s.productCount || 0,
      authMethod: s.authMethod || null,
      shopName: s.shopName || null,
      scopes: {
        products: !!s.scopes?.products,
        orders: !!s.scopes?.orders,
      },
      orderTrackingEnabled: !!s.scopes?.orders,
    },
  });
});

// POST /api/integrations/shopify  { storeUrl, accessToken }
exports.connectShopify = asyncHandler(async (req, res) => {
  const { storeUrl, accessToken } = req.body;
  if (!storeUrl || !accessToken) {
    res.status(400);
    throw new Error("storeUrl and accessToken required");
  }
  const test = await shopify.testConnection(storeUrl, accessToken);
  if (!test.ok) {
    res.status(400);
    throw new Error(
      typeof test.error === "string" ? test.error : "Shopify connection failed",
    );
  }

  const scopes = await shopify.verifyScopes(storeUrl, accessToken);
  if (!scopes.products) {
    res.status(400);
    throw new Error(
      "We couldn't connect to your store. Please check your Shopify login and try again.",
    );
  }

  const products = await shopify.listProducts(storeUrl, accessToken, 50);
  const warnings = [];
  if (!scopes.orders) {
    warnings.push(
      "Order updates in DMs require additional store permissions. Reconnect your store if order lookups don't work.",
    );
  }

  await Workspace.findByIdAndUpdate(req.workspace._id, {
    "integrations.shopify.storeUrl": shopify.normalizeStoreUrl(storeUrl),
    "integrations.shopify.accessToken": encrypt(accessToken),
    "integrations.shopify.connectedAt": new Date(),
    "integrations.shopify.productCount": products.length,
    "integrations.shopify.scopes": scopes,
    "integrations.shopify.scopesCheckedAt": new Date(),
    "integrations.shopify.authMethod": "manual",
  });
  res.json({
    success: true,
    shop: test.shop,
    products: products.length,
    scopes,
    orderTrackingEnabled: scopes.orders,
    warnings,
  });
});

// POST /api/integrations/shopify/storefront  { storeUrl }
// Tokenless — merchant gives store name only, zero admin setup required.
exports.connectShopifyStorefront = asyncHandler(async (req, res) => {
  const { storeUrl } = req.body;
  if (!storeUrl) {
    res.status(400);
    throw new Error("storeUrl required");
  }

  const test = await shopify.testStorefront(storeUrl);
  if (!test.ok) {
    res.status(400);
    throw new Error(test.error || "Could not reach that Shopify store. Make sure the store name is correct (e.g. your-store-name).");
  }

  const products = await shopify.listAllProductsStorefront(storeUrl, 1000);

  await Workspace.findByIdAndUpdate(req.workspace._id, {
    "integrations.shopify.storeUrl": shopify.normalizeStoreUrl(storeUrl),
    "integrations.shopify.accessToken": null,
    "integrations.shopify.connectedAt": new Date(),
    "integrations.shopify.productCount": products.length,
    "integrations.shopify.scopes": { products: true, orders: false },
    "integrations.shopify.scopesCheckedAt": new Date(),
    "integrations.shopify.authMethod": "storefront",
    "integrations.shopify.shopName": test.shopName,
  });

  res.json({
    success: true,
    shop: test.shopName,
    products: products.length,
    authMethod: "storefront",
    orderTrackingEnabled: false,
  });
});

// GET /api/integrations/shopify/products
exports.listShopifyProducts = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select(
    "+integrations.shopify.accessToken",
  );
  const s = ws?.integrations?.shopify;
  if (!s?.storeUrl) {
    res.status(400);
    throw new Error("Shopify not connected");
  }

  // Storefront-connected stores use tokenless API (fetch all)
  const products =
    s.authMethod === "storefront" || !s.accessToken
      ? await shopify.listAllProductsStorefront(s.storeUrl, 1000)
      : await shopify.listProducts(s.storeUrl, decrypt(s.accessToken), 250);

  res.json({ success: true, products });
});

// DELETE /api/integrations/shopify
exports.disconnectShopify = asyncHandler(async (req, res) => {
  await Workspace.findByIdAndUpdate(req.workspace._id, {
    "integrations.shopify": {},
  });
  res.json({ success: true });
});

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

// ─── Make.com ───────────────────────────────────────────────────────────────

const MAKE_API_REGIONS = ["us1", "us2", "eu1", "eu2"];

// Helper: call Make.com API with a given token + region
const makeApiCall = async (token, region = "us1", path) => {
  const base = `https://${region}.make.com/api/v2`;
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Make API ${res.status}: ${err}`);
  }
  return res.json();
};

// Auto-detect region by trying each until one works
const detectRegion = async (token) => {
  for (const region of MAKE_API_REGIONS) {
    try {
      const data = await makeApiCall(token, region, "/users/me");
      return { region, user: data };
    } catch {
      // try next
    }
  }
  throw new Error("Invalid API token or Make.com is unreachable. Please check your token.");
};

// GET /api/integrations/make
exports.getMake = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id);
  const m = ws?.integrations?.make || {};
  res.json({
    success: true,
    make: {
      connected: !!m.connected,
      accountEmail: m.accountEmail || null,
      region: m.region || "us1",
      teamId: m.teamId || null,
      linkedScenarioId: m.linkedScenarioId || null,
      linkedScenarioName: m.linkedScenarioName || null,
      linkedHookUrl: m.linkedHookUrl || null,
      connectedAt: m.connectedAt || null,
      lastSyncAt: m.lastSyncAt || null,
    },
  });
});

// POST /api/integrations/make/connect  { apiToken }
// Validates the token, detects region, saves encrypted token
exports.connectMake = asyncHandler(async (req, res) => {
  const { apiToken } = req.body;
  if (!apiToken || apiToken.trim().length < 10) {
    res.status(400);
    throw new Error("A valid Make.com API token is required");
  }

  const token = apiToken.trim();
  const { region, user } = await detectRegion(token);

  // user object shape varies — extract what we can
  const email =
    user?.user?.email ||
    user?.email ||
    user?.data?.email ||
    null;
  let teamId =
    user?.user?.teamId ||
    user?.teamId ||
    user?.data?.teamId ||
    null;

  // Let's resolve teamId via organizations if it's missing (which it typically is in users/me)
  if (!teamId) {
    try {
      const orgsData = await makeApiCall(token, region, "/organizations");
      const orgId = orgsData?.organizations?.[0]?.id;
      if (orgId) {
        const teamsData = await makeApiCall(token, region, `/teams?organizationId=${orgId}`);
        teamId = teamsData?.teams?.[0]?.id;
      }
    } catch (err) {
      console.error("Error fetching organizations/teams for Make connection:", err);
    }
  }

  await Workspace.findByIdAndUpdate(req.workspace._id, {
    "integrations.make.apiToken": encrypt(token),
    "integrations.make.connected": true,
    "integrations.make.connectedAt": new Date(),
    "integrations.make.region": region,
    "integrations.make.accountEmail": email,
    "integrations.make.teamId": teamId || null,
    "integrations.make.lastSyncAt": new Date(),
  });

  res.json({ success: true, region, email, teamId });
});

// GET /api/integrations/make/scenarios
// Returns user's scenarios, each annotated with hasWebhook + webhookUrl
exports.listMakeScenarios = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select(
    "+integrations.make.apiToken",
  );
  const m = ws?.integrations?.make;
  if (!m?.apiToken || !m?.connected) {
    res.status(400);
    throw new Error("Make.com not connected");
  }

  const token = decrypt(m.apiToken);
  const region = m.region || "us1";

  let teamId = m.teamId;

  // Dynamic recovery for existing connected workspaces that missed teamId
  if (!teamId) {
    try {
      const orgsData = await makeApiCall(token, region, "/organizations");
      const orgId = orgsData?.organizations?.[0]?.id;
      if (orgId) {
        const teamsData = await makeApiCall(token, region, `/teams?organizationId=${orgId}`);
        teamId = teamsData?.teams?.[0]?.id;
        if (teamId) {
          await Workspace.findByIdAndUpdate(req.workspace._id, {
            "integrations.make.teamId": teamId,
          });
        }
      }
    } catch (err) {
      console.error("Error auto-recovering teamId in listMakeScenarios:", err);
    }
  }

  if (!teamId) {
    res.status(400);
    throw new Error("Could not retrieve teamId or organizationId for Make.com. Please try reconnecting.");
  }

  // Fetch scenarios + hooks in parallel, scoped to the teamId
  const [scenariosData, hooksData] = await Promise.all([
    makeApiCall(token, region, `/scenarios?teamId=${teamId}&pg[sortBy]=updatedAt&pg[sortDir]=desc&pg[limit]=100`),
    makeApiCall(token, region, `/hooks?teamId=${teamId}&pg[limit]=200`),
  ]);

  const scenarios = scenariosData?.scenarios || [];
  const hooks = hooksData?.hooks || [];

  // Build a scenarioId → hook map
  const hookByScenario = {};
  for (const h of hooks) {
    if (h.scenarioId && !hookByScenario[h.scenarioId]) {
      hookByScenario[h.scenarioId] = h;
    }
  }

  const enriched = scenarios.map((s) => {
    const hook = hookByScenario[s.id] || null;
    return {
      id: s.id,
      name: s.name,
      isActive: s.isEnabled && !s.isPaused,
      isPaused: s.isPaused || false,
      updatedAt: s.updatedAt,
      hasWebhook: !!hook,
      webhookUrl: hook?.url || null,
      hookId: hook?.id || null,
    };
  });

  await Workspace.findByIdAndUpdate(req.workspace._id, {
    "integrations.make.lastSyncAt": new Date(),
  });

  res.json({ success: true, scenarios: enriched });
});

// POST /api/integrations/make/link  { scenarioId, scenarioName, webhookUrl, hookId }
// Links a specific scenario — auto-creates / updates the WebhookIntegration record
exports.linkMakeScenario = asyncHandler(async (req, res) => {
  const { scenarioId, scenarioName, webhookUrl, hookId } = req.body;

  if (!webhookUrl) {
    res.status(400);
    throw new Error(
      "Selected scenario has no webhook trigger. Add a 'Custom webhook' module as the first step in Make, then try again.",
    );
  }

  const ws = req.workspace;

  // Save linked scenario on workspace
  await Workspace.findByIdAndUpdate(ws._id, {
    "integrations.make.linkedScenarioId": scenarioId,
    "integrations.make.linkedScenarioName": scenarioName,
    "integrations.make.linkedHookUrl": webhookUrl,
    "integrations.make.linkedHookId": hookId || null,
  });

  // Upsert WebhookIntegration so the dispatcher fires to this URL
  const WebhookIntegration = require("../models/WebhookIntegration");
  let existing = await WebhookIntegration.findOne({
    workspaceId: ws._id,
    name: { $regex: /^Make\.com/i },
  });

  const payload = {
    workspaceId: ws._id,
    name: `Make.com — ${scenarioName}`,
    url: webhookUrl,
    enabled: true,
    events: [
      "dm.received",
      "dm.sent",
      "comment.received",
      "lead.created",
      "flow.completed",
      "contact.tagged",
    ],
  };

  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
  } else {
    existing = await WebhookIntegration.create(payload);
  }

  res.json({
    success: true,
    message: `Linked to "${scenarioName}" — Botlify will now fire all events to your Make.com scenario.`,
    integrationId: existing._id,
  });
});

// DELETE /api/integrations/make
exports.disconnectMake = asyncHandler(async (req, res) => {
  const ws = req.workspace;

  // Remove linked webhook integration
  const WebhookIntegration = require("../models/WebhookIntegration");
  await WebhookIntegration.deleteMany({
    workspaceId: ws._id,
    name: { $regex: /^Make\.com/i },
  });

  await Workspace.findByIdAndUpdate(ws._id, {
    "integrations.make": {
      connected: false,
    },
  });

  res.json({ success: true });
});
