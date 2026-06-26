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
    throw new Error(
      "Could not reach that Shopify store. Make sure the store name is correct (e.g. your-store-name).",
    );
  }

  const products = await shopify.listProductsStorefront(storeUrl, 50);

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

  // Storefront-connected stores use tokenless API
  const products =
    s.authMethod === "storefront" || !s.accessToken
      ? await shopify.listProductsStorefront(s.storeUrl, 50)
      : await shopify.listProducts(s.storeUrl, decrypt(s.accessToken), 50);

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
