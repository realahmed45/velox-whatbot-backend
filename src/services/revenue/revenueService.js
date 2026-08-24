/**
 * revenueService — the AI Revenue Manager.
 *
 * Small hotels price by gut and lose money on both ends: empty rooms priced too
 * high, and full nights sold too cheap. We already know their real occupancy,
 * their booking pace, and (anonymously) how the rest of our network is filling
 * for the same dates. This turns that into ONE readable suggestion per room per
 * date range.
 *
 * Deliberately conservative:
 *  - never suggests a change smaller than MIN_CHANGE_PCT (noise is not advice)
 *  - never moves a rate more than MAX_CHANGE_PCT in one step
 *  - always respects the owner min/max guard rails
 *  - default mode is "suggest" — nothing reaches an OTA without a tap
 */
const logger = require("../../utils/logger");
const { nightlyAvailability, toDay, DAY_MS } = require("../hotel/availability");

// Tuning knobs, all in one place.
const HORIZON_DAYS = 30; // how far ahead we look
const WINDOW_DAYS = 3; // group suggestions into runs of up to N nights
const MIN_CHANGE_PCT = 0.05; // ignore anything under a 5% move
const MAX_CHANGE_PCT = 0.25; // never jump more than 25% at once
const LOW_OCC = 0.4;
const HIGH_OCC = 0.8; // at/above this we raise

/**
 * What occupancy SHOULD look like this far out. A night 2 days away is expected
 * to be much fuller than one 30 days away; comparing raw occupancy without this
 * is what makes naive pricing tools panic.
 */
function expectedOccupancy(daysToArrival) {
  if (daysToArrival <= 2) return 0.85;
  if (daysToArrival <= 5) return 0.7;
  if (daysToArrival <= 10) return 0.55;
  if (daysToArrival <= 20) return 0.4;
  return 0.25;
}

const pct = (n) => Math.round(n * 100) + "%";

function fmtDay(d) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d);
}

/**
 * Anonymous cross-hotel demand for a date: what share of the network's rooms in
 * the same city are already sold. Never exposes any single hotel. Returns null
 * when there are too few peers for the number to mean anything.
 */
async function networkOccupancy(property, date) {
  const Property = require("../../models/Property");
  const RoomType = require("../../models/RoomType");
  const HotelBooking = require("../../models/HotelBooking");
  if (!property.city) return null;

  const peers = await Property.find({
    city: property.city,
    _id: { $ne: property._id },
    active: true,
  })
    .select("_id")
    .limit(200)
    .lean();
  // Below 5 peers this is one hotel's noise, not a market signal.
  if (peers.length < 5) return null;

  const peerIds = peers.map((p) => p._id);
  const [rooms, booked] = await Promise.all([
    RoomType.aggregate([
      { $match: { propertyId: { $in: peerIds }, active: true } },
      { $group: { _id: null, units: { $sum: "$unitsCount" } } },
    ]),
    HotelBooking.aggregate([
      {
        $match: {
          propertyId: { $in: peerIds },
          status: { $in: ["pending", "confirmed"] },
          checkIn: { $lte: date },
          checkOut: { $gt: date },
        },
      },
      { $group: { _id: null, units: { $sum: "$unitsBooked" } } },
    ]),
  ]);
  const total = rooms[0] && rooms[0].units ? rooms[0].units : 0;
  if (!total) return null;
  const sold = booked[0] && booked[0].units ? booked[0].units : 0;
  return Math.min(1, sold / total);
}

/**
 * Build (and persist) pricing suggestions for one property.
 * @returns {Promise<{created:number, applied:number}>}
 */
async function generateForProperty(property, opts = {}) {
  const RoomType = require("../../models/RoomType");
  const RateSuggestion = require("../../models/RateSuggestion");

  const cfg = property.revenue || {};
  if (cfg.enabled === false) return { created: 0, applied: 0 };
  const mode =
    opts.autoApply === undefined || opts.autoApply === null
      ? cfg.mode || "suggest"
      : opts.autoApply
        ? "auto"
        : "suggest";

  const roomTypes = await RoomType.find({
    propertyId: property._id,
    active: true,
  });
  if (!roomTypes.length) return { created: 0, applied: 0 };

  const today = toDay(new Date());
  let created = 0;
  let applied = 0;

  for (const rt of roomTypes) {
    if (!rt.baseRate || rt.baseRate <= 0) continue; // nothing to price against

    const nights = await nightlyAvailability(rt, today, HORIZON_DAYS);
    const units = rt.unitsCount || 1;

    // Score every night, then merge neighbouring nights that want the same move.
    const scored = [];
    for (const n of nights) {
      const daysOut = Math.round((n.date - today) / DAY_MS);
      if (daysOut < 1) continue; // never re-price tonight out from under a guest
      const occ = (units - n.available) / units;
      const expected = expectedOccupancy(daysOut);
      const net = await networkOccupancy(property, n.date);

      let direction = "hold";
      // Emptier than it should be by this point → discount to fill.
      if (occ < expected * 0.6 && occ < HIGH_OCC) direction = "drop";
      // Nearly full, or the whole city is full → capture the demand.
      if (occ >= HIGH_OCC || (net !== null && net >= 0.8 && occ >= LOW_OCC)) {
        direction = "raise";
      }
      scored.push({
        date: n.date,
        available: n.available,
        daysOut,
        occ,
        expected,
        net,
        direction,
      });
    }

    // Merge consecutive same-direction nights into one suggestion.
    const runs = [];
    let run = null;
    for (const s of scored) {
      if (s.direction === "hold") {
        if (run) {
          runs.push(run);
          run = null;
        }
        continue;
      }
      if (run && run.direction === s.direction && run.nights.length < WINDOW_DAYS) {
        run.nights.push(s);
      } else {
        if (run) runs.push(run);
        run = { direction: s.direction, nights: [s] };
      }
    }
    if (run) runs.push(run);

    for (const r of runs) {
      const first = r.nights[0];
      const last = r.nights[r.nights.length - 1];
      const avgOcc = r.nights.reduce((a, n) => a + n.occ, 0) / r.nights.length;
      const hasNet = r.nights.some((n) => n.net !== null);
      const avgNet = hasNet
        ? r.nights.reduce((a, n) => a + (n.net === null ? 0 : n.net), 0) /
          r.nights.length
        : null;

      // How hard to move: further from expectation = bigger step, capped both ways.
      const gap = Math.abs(avgOcc - first.expected);
      let move = Math.min(MAX_CHANGE_PCT, Math.max(MIN_CHANGE_PCT, gap));
      if (r.direction === "drop") move = -move;

      let suggested = Math.round(rt.baseRate * (1 + move));
      // Guard rails the owner set.
      if (cfg.minRate) suggested = Math.max(cfg.minRate, suggested);
      if (cfg.maxRate) suggested = Math.min(cfg.maxRate, suggested);
      if (suggested === rt.baseRate) continue;
      if (Math.abs(suggested - rt.baseRate) / rt.baseRate < MIN_CHANGE_PCT) {
        continue;
      }

      const unsold = r.nights.reduce((a, n) => a + n.available, 0);
      const dateLabel =
        r.nights.length === 1
          ? fmtDay(first.date)
          : fmtDay(first.date) + "–" + fmtDay(last.date);

      const reason =
        r.direction === "drop"
          ? dateLabel +
            " is " +
            pct(avgOcc) +
            " booked — usually " +
            pct(first.expected) +
            " this close. " +
            unsold +
            (unsold === 1 ? " room" : " rooms") +
            " still unsold."
          : dateLabel +
            " is " +
            pct(avgOcc) +
            " booked" +
            (avgNet !== null && avgNet >= 0.8
              ? " and hotels near you are " + pct(avgNet) + " full."
              : " — demand is strong.");

      const dateFrom = first.date;
      const dateTo = new Date(last.date.getTime() + DAY_MS);

      // One live suggestion per room+range: replace any previous pending one.
      await RateSuggestion.updateMany(
        { roomTypeId: rt._id, dateFrom, dateTo, status: "pending" },
        { $set: { status: "expired" } },
      );

      const doc = await RateSuggestion.create({
        workspaceId: property.workspaceId,
        propertyId: property._id,
        roomTypeId: rt._id,
        dateFrom,
        dateTo,
        currentRate: rt.baseRate,
        suggestedRate: suggested,
        currency: rt.currency || property.currency || "USD",
        reason,
        direction: r.direction,
        signals: {
          occupancyPct: Math.round(avgOcc * 100),
          expectedOccupancyPct: Math.round(first.expected * 100),
          daysToArrival: first.daysOut,
          unsoldUnits: unsold,
          networkOccupancyPct:
            avgNet === null ? undefined : Math.round(avgNet * 100),
        },
      });
      created++;

      if (mode === "auto") {
        const res = await applySuggestion(doc, { by: "auto" });
        if (res.ok) applied++;
      }
    }
  }

  logger.info(
    "[revenue] property=" +
      property._id +
      " suggestions=" +
      created +
      " auto-applied=" +
      applied,
  );
  return { created, applied };
}

/**
 * Apply an approved suggestion: set the room rate and push it to the OTAs.
 * A push failure must not lose the owner's decision — the local rate stands
 * either way, and it is the source of truth for direct/social quotes.
 */
async function applySuggestion(suggestion, opts = {}) {
  const RoomType = require("../../models/RoomType");
  const Property = require("../../models/Property");
  const RateSuggestion = require("../../models/RateSuggestion");
  const doc =
    suggestion && typeof suggestion.save === "function"
      ? suggestion
      : await RateSuggestion.findById(suggestion);
  if (!doc) return { ok: false, reason: "not_found" };
  if (doc.status === "approved") return { ok: true, already: true };

  const rt = await RoomType.findById(doc.roomTypeId);
  const property = await Property.findById(doc.propertyId);
  if (!rt || !property) return { ok: false, reason: "missing_room" };

  rt.baseRate = doc.suggestedRate;
  await rt.save();

  let error = "";
  try {
    // Whichever channel manager this property is on (Channex, Beds24, …) — or
    // none, in which case the local rate is simply the whole story.
    const { getProvider, providerRoomId } = require("../channels");
    const channel = getProvider(property);
    if (
      channel &&
      providerRoomId(property, rt) &&
      typeof channel.pushRateRange === "function"
    ) {
      await channel.pushRateRange(
        property,
        rt,
        doc.dateFrom,
        doc.dateTo,
        doc.suggestedRate,
      );
    }
  } catch (e) {
    error = e.message;
    logger.warn("[revenue] rate push failed", {
      provider: property.channel?.provider,
      err: e.message,
    });
  }

  doc.status = "approved";
  doc.appliedAt = new Date();
  doc.appliedBy = opts.by || "";
  doc.error = error;
  await doc.save();

  return { ok: true, rate: doc.suggestedRate, pushError: error || null };
}

/** Owner dismissed it — never show that one again. */
async function skipSuggestion(id) {
  const RateSuggestion = require("../../models/RateSuggestion");
  const doc = await RateSuggestion.findById(id);
  if (!doc) return { ok: false, reason: "not_found" };
  doc.status = "skipped";
  await doc.save();
  return { ok: true };
}

/** Run the engine for every active property that has it enabled. */
async function generateAll() {
  const Property = require("../../models/Property");
  const props = await Property.find({
    active: true,
    "revenue.enabled": { $ne: false },
  });
  let created = 0;
  let applied = 0;
  for (const p of props) {
    try {
      const r = await generateForProperty(p);
      created += r.created;
      applied += r.applied;
    } catch (e) {
      logger.warn("[revenue] property failed", {
        id: String(p._id),
        err: e.message,
      });
    }
  }
  logger.info(
    "[revenue] daily run: " +
      created +
      " suggestions across " +
      props.length +
      " properties",
  );
  return { properties: props.length, created, applied };
}

module.exports = {
  generateForProperty,
  generateAll,
  applySuggestion,
  skipSuggestion,
  networkOccupancy,
  expectedOccupancy,
};
