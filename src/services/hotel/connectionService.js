/**
 * connectionService.js — the honest state of a property's OTA connection.
 *
 * Two jobs, deliberately separate:
 *
 *  1. evaluateReadiness(property) — the GUARD RAIL. When a hotel connects a
 *     channel manager, Booking.com hands rate and availability control to that
 *     system. If we accept that control while a room has no rate, we will push
 *     a zero rate onto a live listing and break the hotel's real business. So
 *     we refuse to be "ready" until the inventory can actually be sold:
 *     at least one room type, every room with units and a rate, and real
 *     availability to sell. Blockers come back as plain sentences a hotelier
 *     can act on, never as codes.
 *
 *  2. refreshConnectionState(property) — asks the ACTIVE PROVIDER what it
 *     knows and writes `channel.sync`. Never invents progress: a state only
 *     advances on evidence from the provider. When no provider is configured
 *     (the common case during onboarding, and on any deployment without OTA
 *     keys) it degrades to `not_started` and returns without throwing.
 *
 * Nothing here ever throws at a caller: this runs inside a cron sweep and
 * behind a screen the hotelier is looking at. A provider outage must show as
 * "we couldn't check just now", not as a 500.
 */
const Property = require("../../models/Property");
const RoomType = require("../../models/RoomType");
const { getProvider } = require("../channels");
const logger = require("../../utils/logger");

/** The lifecycle states, in the order they progress. */
const STATES = {
  NOT_STARTED: "not_started",
  IMPORTING: "importing",
  IMPORTED: "imported",
  AWAITING: "awaiting_ota_approval",
  LIVE: "live",
  ERROR: "error",
};

/** States the connection is still moving through — worth polling/sweeping. */
const TRANSITIONAL = [STATES.IMPORTING, STATES.AWAITING];

/** How long a look-ahead window counts as "has availability to sell". */
const AVAILABILITY_HORIZON_DAYS = 30;

/* ── 1. Readiness ─────────────────────────────────────────────────────────── */

/**
 * Can we safely let the OTAs take their rates and availability from us?
 *
 * Checks, in the order a hotelier would think about them:
 *   • Is there anything to sell at all? (≥1 active room type)
 *   • Does each room have physical inventory? (unitsCount ≥ 1)
 *   • Does each room have a price? (baseRate > 0)
 *   • Is any of it actually free to book in the near future?
 *
 * @param {object} property  Property doc or lean object
 * @returns {Promise<{ready: boolean, blockers: string[], roomCount: number}>}
 */
async function evaluateReadiness(property) {
  const blockers = [];
  if (!property?._id) {
    return {
      ready: false,
      blockers: ["Add your property details before connecting a channel."],
      roomCount: 0,
    };
  }

  let rooms = [];
  try {
    rooms = await RoomType.find({ propertyId: property._id, active: { $ne: false } })
      .select("name unitsCount baseRate")
      .lean();
  } catch (err) {
    logger.warn(`[connection] room lookup failed: ${err.message}`);
    return {
      ready: false,
      blockers: ["We couldn't check your rooms just now — try again in a moment."],
      roomCount: 0,
    };
  }

  if (!rooms.length) {
    blockers.push(
      "Add at least one room type — the channels need something to sell.",
    );
  }

  for (const room of rooms) {
    const label = room.name || "your room";
    if (!(Number(room.unitsCount) >= 1)) {
      blockers.push(`Tell us how many ${label} rooms you have.`);
    }
    if (!(Number(room.baseRate) > 0)) {
      blockers.push(`Set a nightly rate for ${label}.`);
    }
  }

  // Availability: with rooms priced and counted, is anything bookable soon? A
  // fully booked month is not a blocker to being *correct*, but a property
  // with zero sellable nights would push an empty calendar to the OTAs, so we
  // check it and say so plainly.
  if (rooms.length && !blockers.length) {
    const hasAvailability = await anyAvailability(rooms);
    if (hasAvailability === false) {
      blockers.push(
        `Every room is fully booked for the next ${AVAILABILITY_HORIZON_DAYS} days — ` +
          "open some dates before we switch the channels over.",
      );
    }
    // `null` means we couldn't tell (lookup failed). Not a blocker: we don't
    // hold a hotelier up over our own hiccup.
  }

  return { ready: blockers.length === 0, blockers, roomCount: rooms.length };
}

/**
 * Is at least one unit of any room free on at least one night in the horizon?
 *
 * Uses nightlyAvailability rather than getAvailableUnits: the latter answers
 * "can I book this whole span", which a healthy, busy hotel would fail. We
 * only want to know that the calendar isn't completely sold out.
 *
 * @returns {Promise<boolean|null>} null when we couldn't determine it
 */
async function anyAvailability(rooms) {
  try {
    const { nightlyAvailability } = require("./availability");
    const from = new Date();
    for (const room of rooms) {
      const nights = await nightlyAvailability(
        room,
        from,
        AVAILABILITY_HORIZON_DAYS,
      );
      if ((nights || []).some((n) => Number(n.available) > 0)) return true;
    }
    return false;
  } catch (err) {
    logger.warn(`[connection] availability probe failed: ${err.message}`);
    return null;
  }
}

/* ── 2. Provider state ────────────────────────────────────────────────────── */

/**
 * Ask the provider what's live, and turn that into the state machine.
 *
 * The distinction that matters to the hotelier: `imported` means we have their
 * content and the AI can already sell; `awaiting_ota_approval` means the
 * mapping exists on the provider side and Booking.com's own review (1–5 days,
 * out of everyone's hands) is running; `live` means an OTA is genuinely
 * exchanging rates and availability with us.
 *
 * @param {object} property  Property doc or lean object (needs _id + channel)
 * @returns {Promise<object>} the resulting `channel.sync` value
 */
async function refreshConnectionState(property) {
  const now = new Date();
  const current = property?.channel?.sync || {};

  // Readiness is provider-independent — a manual property still deserves to
  // know its rooms aren't priced.
  const { ready, blockers, roomCount } = await evaluateReadiness(property);

  const base = {
    state: current.state || STATES.NOT_STARTED,
    otaStatus: Array.isArray(current.otaStatus) ? current.otaStatus : [],
    readyToActivate: ready,
    blockers,
    lastCheckedAt: now,
    message: current.message || "",
  };

  const provider = getProvider(property);

  // No provider (or keys absent): nothing to ask. The hotel is running on
  // direct + AI only, which is a legitimate end state, not an error.
  if (!provider) {
    const imported = hasProviderId(property);
    base.state = imported ? STATES.IMPORTED : STATES.NOT_STARTED;
    base.otaStatus = [];
    base.message = imported
      ? "Your rooms are set up. Channel sync isn't switched on for this account yet."
      : "No booking channel connected yet. Your AI still takes direct bookings.";
    return persist(property, base);
  }

  // A provider is configured — ask it what's actually connected.
  let connectedOtas = [];
  try {
    connectedOtas = await providerConnectedOtas(provider, property);
  } catch (err) {
    logger.warn(
      `[connection] provider check failed property=${property._id}: ${err.message}`,
    );
    base.state = STATES.ERROR;
    base.message =
      "We couldn't reach your channel manager just now. We'll keep trying — " +
      "nothing you've set up is affected.";
    return persist(property, base);
  }

  const requested = property?.channel?.requestedOtas || [];
  base.otaStatus = buildOtaStatus(requested, connectedOtas, current.otaStatus, now);

  if (connectedOtas.length > 0) {
    base.state = STATES.LIVE;
    base.message = `Syncing with ${humanJoin(connectedOtas.map(prettyOta))}.`;
  } else if (hasProviderId(property)) {
    // We hold the mapping but no channel reports live yet — this is the
    // approval wait, and it is normal.
    base.state = roomCount > 0 ? STATES.AWAITING : STATES.IMPORTED;
    base.message =
      base.state === STATES.AWAITING
        ? "Waiting for your OTA to approve the connection. This usually takes 1–5 days " +
          "and is entirely on their side — your AI is already taking bookings."
        : "Imported. Add your rooms and we'll start the channel connection.";
  } else {
    base.state = STATES.NOT_STARTED;
    base.message =
      "No booking channel connected yet. Your AI still takes direct bookings.";
  }

  return persist(property, base);
}

/** Does the property carry a provider-side id (i.e. was it ever imported)? */
function hasProviderId(property) {
  const ch = property?.channel || {};
  return !!(ch.channexPropertyId || ch.beds24PropertyId);
}

/**
 * The OTAs a provider reports as live for this property. Channex exposes a
 * /channels collection; Beds24 reports channel flags inside the property
 * payload, so we re-import the property view and read them off it.
 */
async function providerConnectedOtas(provider, property) {
  const ch = property?.channel || {};
  if (ch.provider === "channex" && ch.channexPropertyId) {
    if (typeof provider.listConnectedChannels === "function") {
      const names = await provider.listConnectedChannels(ch.channexPropertyId);
      return dedupe(names).filter((n) => n && n !== "unknown");
    }
    return [];
  }
  if (ch.provider === "beds24" && ch.beds24PropertyId) {
    // connectedOtasFrom isn't exported; getProperty + the same shape the
    // import reads gives us the identical answer without widening that API.
    const bp = await provider.getProperty(ch.beds24PropertyId);
    const names = new Set();
    for (const room of bp?.roomTypes || []) {
      const channels = room.channels || room.channelSettings || {};
      for (const [key, val] of Object.entries(channels)) {
        const on =
          val === true || val?.enabled === true || val?.connected === true;
        if (on) names.add(provider.sourceFromOta(key));
      }
    }
    return [...names].filter(Boolean);
  }
  return [];
}

/**
 * Merge what the hotel asked for with what's actually live. An OTA the hotel
 * named but the provider doesn't report is `pending` — never silently dropped,
 * because "where's my Booking.com?" is the question this list has to answer.
 */
function buildOtaStatus(requested, connected, previous, now) {
  const prev = new Map((previous || []).map((o) => [o.ota, o]));
  const live = new Set(connected);
  const all = dedupe([...(requested || []), ...connected]);

  return all.map((ota) => {
    const isLive = live.has(ota);
    const before = prev.get(ota);
    const status = isLive ? "live" : "pending";
    return {
      ota,
      status,
      message: isLive
        ? "Rates and availability are syncing."
        : "Waiting for approval on their side — usually 1–5 days.",
      // Keep the original timestamp when nothing changed, so the UI can show
      // an honest "pending since".
      updatedAt: before && before.status === status ? before.updatedAt || now : now,
    };
  });
}

/**
 * Write the computed state back. Uses an update rather than doc.save() so a
 * lean object works just as well as a hydrated document.
 */
async function persist(property, sync) {
  try {
    await Property.updateOne(
      { _id: property._id },
      { $set: { "channel.sync": sync } },
    );
  } catch (err) {
    logger.warn(
      `[connection] persist failed property=${property?._id}: ${err.message}`,
    );
  }
  return sync;
}

/* ── Presentation helpers ─────────────────────────────────────────────────── */

const dedupe = (arr) => [...new Set((arr || []).filter(Boolean))];

/** "booking_com" → "Booking.com" */
function prettyOta(key = "") {
  const map = {
    booking_com: "Booking.com",
    airbnb: "Airbnb",
    agoda: "Agoda",
    expedia: "Expedia",
    traveloka: "Traveloka",
    hostelworld: "Hostelworld",
    vrbo: "Vrbo",
    tripadvisor: "Tripadvisor",
    direct: "Direct",
  };
  if (map[key]) return map[key];
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "Booking.com, Agoda and Airbnb" */
function humanJoin(names = []) {
  const list = names.filter(Boolean);
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

module.exports = {
  evaluateReadiness,
  refreshConnectionState,
  STATES,
  TRANSITIONAL,
  prettyOta,
  humanJoin,
};
