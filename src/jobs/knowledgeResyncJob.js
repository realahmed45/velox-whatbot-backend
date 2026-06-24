/**
 * Knowledge freshness job — keeps the AI bot's imported knowledge up to date.
 *
 * Re-scrapes website sources and re-pulls Shopify catalogs that haven't been
 * refreshed in a while, so the bot never quotes stale prices or info.
 * Bounded per run to stay gentle on external sites and our own load.
 */
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const { importWebsite } = require("../services/ai/websiteImporter");
const shopify = require("../services/shopifyService");
const { decrypt } = require("../utils/encryption");

const STALE_DAYS = 7;
const MAX_SOURCES_PER_RUN = 100;

const formatShopify = (products) =>
  `Live Shopify catalog (${products.length} products):\n${products
    .map((p) => {
      const price = p.price ? `${p.currency || ""} ${p.price}`.trim() : "";
      const stock = p.inStock ? "" : " (out of stock)";
      return `- ${p.title}${price ? ` — ${price}` : ""}${stock} · ${p.url}`;
    })
    .join("\n")}`.slice(0, 8000);

const resyncStaleKnowledge = async () => {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const workspaces = await Workspace.find({
    "aiKnowledge.enabled": true,
    "aiKnowledge.sources.0": { $exists: true },
  }).select("+integrations.shopify.accessToken");

  let processed = 0;
  for (const ws of workspaces) {
    if (processed >= MAX_SOURCES_PER_RUN) break;
    let changed = false;

    for (const src of ws.aiKnowledge.sources) {
      if (processed >= MAX_SOURCES_PER_RUN) break;
      if (src.syncedAt && src.syncedAt > cutoff) continue; // still fresh
      if (src.type !== "website" && src.type !== "shopify") continue;

      try {
        if (src.type === "website" && src.url) {
          const r = await importWebsite(src.url);
          src.content = r.content;
          src.charCount = r.charCount;
          src.label = r.title || src.label;
        } else if (src.type === "shopify") {
          const s = ws.integrations?.shopify;
          if (!s?.storeUrl || !s?.accessToken) continue;
          const products = await shopify.listProducts(
            s.storeUrl,
            decrypt(s.accessToken),
            100,
          );
          const content = formatShopify(products);
          src.content = content;
          src.charCount = content.length;
        }
        src.status = "ready";
        src.syncedAt = new Date();
        changed = true;
        processed++;
        await new Promise((r) => setTimeout(r, 500)); // be gentle
      } catch (err) {
        logger.warn(
          `[cron:knowledgeResync] ws=${ws._id} source=${src._id} failed: ${err.message}`,
        );
      }
    }

    if (changed) {
      ws.aiKnowledge.lastUpdatedAt = new Date();
      try {
        await ws.save();
      } catch (err) {
        logger.warn(`[cron:knowledgeResync] save ws=${ws._id}: ${err.message}`);
      }
    }
  }

  logger.info(`[cron:knowledgeResync] refreshed ${processed} source(s)`);
};

module.exports = { resyncStaleKnowledge };
