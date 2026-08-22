/**
 * availability.js — date-range availability for multi-night stays.
 *
 * A booking occupies [checkIn, checkOut): the checkout day itself is free for
 * the next guest. Available units for a range = roomType.unitsCount minus the
 * MAX simultaneous overlap of active bookings on any night in the range.
 *
 * All dates are normalized to UTC midnight — bookings store calendar days,
 * not clock times (check-in clock time is a property policy, not data).
 */
const HotelBooking = require("../../models/HotelBooking");

const ACTIVE_STATUSES = ["pending", "confirmed"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalize any date input to UTC midnight of its calendar day. */
function toDay(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Nights between two normalized days. */
function nightsBetween(checkIn, checkOut) {
  return Math.round((checkOut - checkIn) / DAY_MS);
}

/**
 * Fetch bookings overlapping [from, to) for a room type.
 * Overlap: b.checkIn < to AND b.checkOut > from.
 */
async function overlappingBookings(roomTypeId, from, to, { excludeId } = {}) {
  const q = {
    roomTypeId,
    status: { $in: ACTIVE_STATUSES },
    checkIn: { $lt: to },
    checkOut: { $gt: from },
  };
  if (excludeId) q._id = { $ne: excludeId };
  return HotelBooking.find(q).select("checkIn checkOut unitsBooked").lean();
}

/**
 * Units of a room type still available for EVERY night in [checkIn, checkOut).
 * Computes per-night occupancy and takes the worst night.
 *
 * @param {object} roomType  RoomType doc (needs unitsCount)
 * @param {Date|string} checkIn
 * @param {Date|string} checkOut
 * @returns {Promise<{ok: boolean, reason?: string, available?: number, nights?: number}>}
 */
async function getAvailableUnits(roomType, checkIn, checkOut, opts = {}) {
  const from = toDay(checkIn);
  const to = toDay(checkOut);
  if (!from || !to) return { ok: false, reason: "invalid_dates" };
  if (to <= from) return { ok: false, reason: "checkout_before_checkin" };
  const today = toDay(new Date());
  if (from < today && !opts.allowPast) return { ok: false, reason: "past_date" };

  const nights = nightsBetween(from, to);
  const bookings = await overlappingBookings(roomType._id, from, to, opts);

  // Per-night occupancy across the requested range.
  let worstOccupied = 0;
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    let occupied = 0;
    for (const b of bookings) {
      if (b.checkIn.getTime() <= t && b.checkOut.getTime() > t) {
        occupied += b.unitsBooked || 1;
      }
    }
    if (occupied > worstOccupied) worstOccupied = occupied;
  }

  const available = Math.max(0, (roomType.unitsCount || 1) - worstOccupied);
  return { ok: true, available, nights, from, to };
}

/**
 * Per-night availability for one room type over [from, from+days) — used for
 * calendars and the AI prompt block.
 * @returns {Promise<Array<{date: Date, available: number}>>}
 */
async function nightlyAvailability(roomType, from, days) {
  const start = toDay(from) || toDay(new Date());
  const end = new Date(start.getTime() + days * DAY_MS);
  const bookings = await overlappingBookings(roomType._id, start, end);
  const out = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    let occupied = 0;
    for (const b of bookings) {
      if (b.checkIn.getTime() <= t && b.checkOut.getTime() > t) {
        occupied += b.unitsBooked || 1;
      }
    }
    out.push({
      date: new Date(t),
      available: Math.max(0, (roomType.unitsCount || 1) - occupied),
    });
  }
  return out;
}

/**
 * Compact availability summary for the AI prompt: contiguous date ranges with
 * at least one free unit, per room type, over the next `days` days.
 * @returns [{roomType, ranges: [{from, to, minAvailable}]}]
 */
async function summarizeAvailability(roomTypes, { days = 30 } = {}) {
  const today = toDay(new Date());
  const out = [];
  for (const rt of roomTypes) {
    const nights = await nightlyAvailability(rt, today, days);
    const ranges = [];
    let cur = null;
    for (const n of nights) {
      if (n.available > 0) {
        if (!cur) {
          cur = { from: n.date, to: n.date, minAvailable: n.available };
        } else {
          cur.to = n.date;
          cur.minAvailable = Math.min(cur.minAvailable, n.available);
        }
      } else if (cur) {
        ranges.push(cur);
        cur = null;
      }
    }
    if (cur) ranges.push(cur);
    out.push({ roomType: rt, ranges });
  }
  return out;
}

module.exports = {
  toDay,
  nightsBetween,
  getAvailableUnits,
  nightlyAvailability,
  summarizeAvailability,
  ACTIVE_STATUSES,
  DAY_MS,
};
