/**
 * Zodomus booking poll — the ONLY delivery path for Zodomus reservations.
 *
 * Zodomus documents no booking webhooks: new, modified and cancelled
 * reservations sit in a per-channel queue until we read them. Runs every
 * minute. A run that overlaps the next is skipped rather than stacked, so a
 * slow API never piles up concurrent drains of the same queue.
 */
const logger = require("../utils/logger");
const zodomus = require("../services/channels/zodomusService");

let running = false;

const pollZodomusBookings = async () => {
  if (!zodomus.isConfigured()) return { ok: false, reason: "not_configured" };
  if (running) return { ok: false, reason: "already_running" };
  running = true;
  try {
    return await zodomus.pollBookings();
  } catch (err) {
    logger.warn("[cron:zodomusPoll] failed: " + err.message);
    return { ok: false, reason: err.message };
  } finally {
    running = false;
  }
};

module.exports = { pollZodomusBookings };
