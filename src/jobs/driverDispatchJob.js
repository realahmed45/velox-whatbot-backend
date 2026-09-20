/**
 * Driver dispatch sweep — moves a job along when a driver doesn't answer.
 *
 * The ten-minute promise only holds if something is watching the clock. A
 * driver who ignores an offer must not strand a guest, so every minute we time
 * out expired offers and hand the job to the next driver in the rotation.
 *
 * Runs every minute rather than every ten: the timeout is per-offer, so a
 * coarse tick would add up to ten minutes of dead time on top of every
 * hand-off. The sweep is a single indexed query and does nothing when idle.
 */
const logger = require("../utils/logger");
const dispatch = require("../services/transfers/dispatchService");

const sweepDriverOffers = async () => {
  try {
    return await dispatch.sweepExpiredOffers();
  } catch (err) {
    logger.warn("[cron:driverDispatch] failed: " + err.message);
    return { ok: false, reason: err.message };
  }
};

module.exports = { sweepDriverOffers };
