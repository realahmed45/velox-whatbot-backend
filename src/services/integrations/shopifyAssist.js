/**
 * Shopify assist — gives the DM bot real, live store data.
 *
 * Before the AI generates a reply we look at the inbound message:
 *   • Order intent ("where's my order #1234")  → look the order up in Shopify
 *   • Product intent ("how much is the tee?")  → pull matching live products
 *
 * Whatever we find is returned as a context block that gets injected into the
 * AI prompt, so the bot answers with REAL prices, stock and tracking — in the
 * creator's own brand voice. Failures never block the reply.
 */
const shopify = require("../shopifyService");
const { decrypt } = require("../../utils/encryption");
const logger = require("../../utils/logger");
const Workspace = require("../../models/Workspace");

const ORDER_INTENT =
  /\b(order|orders|tracking|track|delivery|deliver|shipped|shipping|dispatch|parcel|package|refund|where.{0,15}(order|package|parcel|delivery)|track.{0,10}order|order\s+status|my\s+order|status\s+of\s+my)\b|#\s?\d{3,}/i;
const PRODUCT_INTENT =
  /\b(price|prices|pricing|how much|cost|costs|available|availability|in stock|stock|do you (have|sell|stock)|product|products|size|sizes|colou?r|variant|buy|purchase|recommend|suggestion|looking for|interested in|catalog|catalogue)\b/i;
const ORDER_NUM = /#?\s?(\d{3,})/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

// The Shopify access token is `select: false`, so the workspace passed in from
// the automation flow won't carry it. Fetch it explicitly (only the field we need).
const getCreds = async (workspace) => {
  const s = workspace.integrations?.shopify;
  if (!s?.storeUrl) return null;

  const authMethod = s.authMethod || "manual";

  // Storefront-connected stores don't need a token for products
  if (authMethod === "storefront") {
    return { storeUrl: s.storeUrl, token: null, authMethod: "storefront" };
  }

  let token = s.accessToken;
  if (!token) {
    const ws = await Workspace.findById(workspace._id)
      .select("+integrations.shopify.accessToken")
      .lean();
    token = ws?.integrations?.shopify?.accessToken;
  }
  if (!token) {
    // Treat as storefront-only even if authMethod not set
    return { storeUrl: s.storeUrl, token: null, authMethod: "storefront" };
  }

  try {
    return {
      storeUrl: s.storeUrl,
      token: decrypt(token),
      authMethod: "manual",
    };
  } catch {
    return null;
  }
};

const formatOrder = (o) => {
  const lines = [
    "REAL ORDER STATUS (relay this to the customer in your own voice; do not invent anything):",
    `Order ${o.name}${o.createdAt ? ` placed ${new Date(o.createdAt).toDateString()}` : ""}.`,
    `Payment: ${o.financialStatus}. Fulfillment: ${o.fulfillmentStatus || "not yet fulfilled"}.`,
  ];
  if (o.total) {
    lines.push(`Total: ${o.currency ? `${o.currency} ` : ""}${o.total}.`);
  }
  if (o.trackingNumber) {
    lines.push(
      `Tracking: ${o.trackingNumber}${o.trackingCompany ? ` via ${o.trackingCompany}` : ""}${
        o.trackingUrl ? ` — ${o.trackingUrl}` : ""
      }.`,
    );
  } else if (o.fulfillmentStatus === "fulfilled") {
    lines.push("Shipped — tracking details may still be updating.");
  }
  if (o.items?.length) {
    lines.push(
      `Items: ${o.items.map((i) => `${i.qty}x ${i.title}`).join(", ")}.`,
    );
  }
  if (o.statusUrl) {
    lines.push(`Order status page: ${o.statusUrl}`);
  }
  return lines.join("\n");
};

const formatProducts = (products) =>
  [
    "LIVE PRODUCTS from the store (use these exact names, prices and links — do not invent):",
    ...products.map(
      (p) =>
        `- ${p.title}${p.price ? ` — ${p.currency || ""} ${p.price}`.trimEnd() : ""}${
          p.inStock ? "" : " (out of stock)"
        }${p.url ? ` · ${p.url}` : ""}`,
    ),
  ].join("\n");

const buildContext = async (workspace, text, contact) => {
  if (!text || !workspace?.integrations?.shopify?.storeUrl) return null;
  // Only spend a DB/API call when the message actually looks order/product related.
  const orderIntent = ORDER_INTENT.test(text);
  const productIntent = PRODUCT_INTENT.test(text);
  if (!orderIntent && !productIntent) return null;

  const creds = await getCreds(workspace);
  if (!creds) return null;

  const blocks = [];

  if (orderIntent) {
    if (creds.authMethod === "storefront" || !creds.token) {
      // Storefront-only connection — no order access
      blocks.push(
        "ORDER INTENT detected: this store is connected in product-only mode. Politely let the customer know you can't look up orders right now, and offer to help with product questions instead.",
      );
    } else {
      const numMatch = text.match(ORDER_NUM);
      const emailMatch = text.match(EMAIL);
      const email = emailMatch?.[0] || contact?.email || null;
      const name = numMatch?.[1] || null;

      if (name || email) {
        try {
          const order = await shopify.lookupOrder(creds.storeUrl, creds.token, {
            name,
            email,
          });
          if (order) blocks.push(formatOrder(order));
          else
            blocks.push(
              "ORDER LOOKUP: No matching order found for the details given. Politely ask them to double-check their order number (e.g. #1234) and the email used at checkout.",
            );
        } catch (err) {
          if (err.code === "no_scope") {
            blocks.push(
              "ORDER LOOKUP: order access isn't enabled for this store. Apologise and offer to connect them with a human teammate.",
            );
          } else {
            logger.warn(`[shopifyAssist] order lookup failed: ${err.message}`);
          }
        }
      } else {
        blocks.push(
          "ORDER INTENT detected but no order number/email given. Ask the customer for their order number (e.g. #1234) or checkout email so you can look it up.",
        );
      }
    }
  }

  if (productIntent) {
    try {
      const products =
        creds.authMethod === "storefront" || !creds.token
          ? await shopify
              .listProductsStorefront(creds.storeUrl, 20)
              .then((all) => {
                // Simple title-based search for storefront results
                const words = (
                  String(text)
                    .toLowerCase()
                    .match(/[a-z0-9]{3,}/g) || []
                ).filter(
                  (w) =>
                    !["the", "and", "for", "you", "your", "have"].includes(w),
                );
                if (!words.length) return all.slice(0, 5);
                const scored = all
                  .map((p) => {
                    const t = (p.title || "").toLowerCase();
                    const score = words.reduce(
                      (n, w) => n + (t.includes(w) ? 1 : 0),
                      0,
                    );
                    return { p, score };
                  })
                  .filter((x) => x.score > 0)
                  .sort((a, b) => b.score - a.score);
                return (scored.length ? scored.map((x) => x.p) : all).slice(
                  0,
                  5,
                );
              })
          : await shopify.searchProducts(creds.storeUrl, creds.token, text, 5);

      if (products.length) blocks.push(formatProducts(products));
    } catch (err) {
      logger.warn(`[shopifyAssist] product search failed: ${err.message}`);
    }
  }

  return blocks.length ? blocks.join("\n\n") : null;
};

module.exports = { buildContext, ORDER_INTENT, PRODUCT_INTENT };
