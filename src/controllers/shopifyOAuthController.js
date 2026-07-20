/**
 * Shopify OAuth — one-click store connect (ManyChat-style).
 * Merchant enters store name → redirects to Shopify → we store the token.
 *
 * Env: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_REDIRECT_URI (optional)
 */
const crypto = require("crypto");
const axios = require("axios");
const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const shopify = require("../services/shopifyService");
const { encrypt } = require("../utils/encryption");
const logger = require("../utils/logger");

const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const SCOPES = process.env.SHOPIFY_SCOPES || "read_products,read_orders";
const REDIRECT_URI =
  process.env.SHOPIFY_REDIRECT_URI ||
  `${process.env.API_URL || "http://localhost:5000"}/api/integrations/shopify/callback`;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

const normalizeShopInput = (raw) => {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();

  // If user entered an email, extract the domain part before @
  // e.g. ahmed@mystore.myshopify.com → mystore.myshopify.com
  //      ahmed@mystore.com           → try mystore.myshopify.com
  if (s.includes("@")) {
    const domain = s.split("@")[1] || "";
    if (!domain) return null;
    // If domain is already a myshopify.com address, use it directly
    if (domain.endsWith(".myshopify.com")) {
      s = domain;
    } else {
      // Strip TLD (e.g. mystore.com → mystore), try as store slug
      const slug = domain.split(".")[0];
      if (!slug || slug.length < 2) return null;
      s = `${slug}.myshopify.com`;
    }
  } else {
    s = s.replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!s) return null;
    if (!s.includes(".")) s = `${s}.myshopify.com`;
    if (!s.endsWith(".myshopify.com")) return null;
  }

  return s;
};

const verifyHmac = (query) => {
  const { hmac, ...rest } = query;
  if (!hmac || !API_SECRET) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const hash = crypto
    .createHmac("sha256", API_SECRET)
    .update(message)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, "utf8"),
      Buffer.from(hmac, "utf8"),
    );
  } catch {
    return hash === hmac;
  }
};

/** GET /api/integrations/shopify/oauth-url?shop=mystore */
exports.getOAuthUrl = asyncHandler(async (req, res) => {
  if (!API_KEY || !API_SECRET) {
    return res.status(503).json({
      success: false,
      fallbackManual: true,
      message:
        "Shopify one-click login is not configured on this server. Use the advanced token option or contact support.",
    });
  }

  const shop = normalizeShopInput(req.query.shop || req.body?.shop);
  if (!shop) {
    res.status(400);
    throw new Error(
      "Enter your Shopify store (e.g. mystore or mystore.myshopify.com)",
    );
  }

  const state = Buffer.from(
    JSON.stringify({
      workspaceId: String(req.workspace._id),
      userId: String(req.user._id),
      nonce: crypto.randomBytes(12).toString("hex"),
    }),
  ).toString("base64");

  const url =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(API_KEY)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}`;

  res.json({ success: true, url, shop });
});

/** GET /api/integrations/shopify/callback — public (Shopify redirect) */
exports.oauthCallback = asyncHandler(async (req, res) => {
  const { code, shop, state } = req.query;

  if (!code || !shop || !state) {
    return res.redirect(`${CLIENT_URL}/dashboard?shopify=error&reason=missing`);
  }
  if (!verifyHmac(req.query)) {
    return res.redirect(`${CLIENT_URL}/dashboard?shopify=error&reason=hmac`);
  }

  let workspaceId;
  try {
    ({ workspaceId } = JSON.parse(Buffer.from(state, "base64").toString()));
  } catch {
    return res.redirect(`${CLIENT_URL}/dashboard?shopify=error&reason=state`);
  }

  try {
    const host = shopify.normalizeStoreUrl(shop);
    const { data } = await axios.post(
      `https://${host}/admin/oauth/access_token`,
      {
        client_id: API_KEY,
        client_secret: API_SECRET,
        code,
      },
      { timeout: 15000 },
    );

    const accessToken = data.access_token;
    const scopes = await shopify.verifyScopes(host, accessToken);
    let productCount = 0;
    try {
      const products = await shopify.listProducts(host, accessToken, 50);
      productCount = products.length;
    } catch (e) {
      logger.warn(`[Shopify OAuth] product fetch: ${e.message}`);
    }

    await Workspace.findByIdAndUpdate(workspaceId, {
      "integrations.shopify.storeUrl": host,
      "integrations.shopify.accessToken": encrypt(accessToken),
      "integrations.shopify.connectedAt": new Date(),
      "integrations.shopify.productCount": productCount,
      "integrations.shopify.scopes": scopes,
      "integrations.shopify.scopesCheckedAt": new Date(),
      "integrations.shopify.authMethod": "oauth",
    });

    logger.info(`[Shopify OAuth] connected ws=${workspaceId} shop=${host}`);
    return res.redirect(
      `${CLIENT_URL}/dashboard/apps?shopify=connected&shop=${encodeURIComponent(host)}`,
    );
  } catch (err) {
    logger.error("[Shopify OAuth] callback failed", { err: err.message });
    return res.redirect(
      `${CLIENT_URL}/dashboard/apps?shopify=error&reason=exchange`,
    );
  }
});
