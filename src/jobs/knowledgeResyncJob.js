/**
 * Knowledge freshness job — keeps the AI bot's imported knowledge up to date.
 *
 * Re-scrapes website sources that haven't been refreshed in a while, so the bot
 * never quotes stale info. Bounded per run to stay gentle on external sites.
 */
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const { importWebsite } = require("../services/ai/websiteImporter");

const STALE_DAYS = 7;
const MAX_SOURCES_PER_RUN = 100;

const resyncStaleKnowledge = async () => {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  const workspaces = await Workspace.find({
    "aiKnowledge.enabled": true,
    "aiKnowledge.sources.0": { $exists: true },
  });

  let processed = 0;
  for (const ws of workspaces) {
    if (processed >= MAX_SOURCES_PER_RUN) break;
    let changed = false;

    for (const src of ws.aiKnowledge.sources) {
      if (processed >= MAX_SOURCES_PER_RUN) break;
      if (src.syncedAt && src.syncedAt > cutoff) continue; // still fresh
      if (src.type !== "website" || !src.url) continue;

      try {
        const r = await importWebsite(src.url);
        src.content = r.content;
        src.charCount = r.charCount;
        src.label = r.title || src.label;
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
