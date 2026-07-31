/**
 * slotEngine.js — computes bookable appointment slots for a workspace.
 *
 * Timezone correctness matters: a business in "Asia/Karachi" opening at 09:00
 * means 09:00 THERE, not 09:00 UTC. We do all wall-clock math in the workspace
 * timezone using the built-in Intl API (no moment-timezone dependency), then
 * store/compare absolute UTC instants.
 *
 * Public API:
 *   getAvailableSlots(workspace, { fromDate, service })  -> [{ startAt, label, ... }]
 *   isSlotAvailable(workspace, startAt, service)          -> { ok, reason }
 * both async where they touch the DB (booked appointments).
 */

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
// Map the model's short keys to full names so either form works.
const DAY_ALIASES = {
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
};

/** "HH:MM" -> minutes since midnight. */
function hmToMinutes(hm) {
  const [h, m] = String(hm || "0:0")
    .split(":")
    .map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

/**
 * Get the wall-clock parts of an absolute instant AS SEEN in `tz`.
 * Returns { year, month, day, hour, minute, weekday } (month 1-12, weekday 0=Sun).
 */
function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  const weekdayIdx = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }[parts.weekday];
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hour: +parts.hour === 24 ? 0 : +parts.hour,
    minute: +parts.minute,
    weekday: weekdayIdx,
  };
}

/**
 * The timezone's UTC offset (in minutes) at a given instant. Derived by
 * comparing the wall-clock reading in `tz` to the same instant read as UTC.
 */
function tzOffsetMinutes(date, tz) {
  const p = partsInTz(date, tz);
  // Build a UTC timestamp from the wall-clock parts, then diff against the real
  // instant. asUTC - date = offset (how far ahead of UTC the zone is).
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * Convert a wall-clock time in `tz` (given as y/m/d/h/min) to an absolute UTC
 * Date. Uses the offset at that approximate instant (handles DST closely; a
 * one-hour DST edge is acceptable for appointment slotting).
 */
function wallClockToUtc(y, mo, d, h, mi, tz) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const offset = tzOffsetMinutes(guess, tz);
  return new Date(guess.getTime() - offset * 60000);
}

/** Normalize workspace.businessHours into a { weekdayIdx: {open,close} } map. */
function hoursMap(businessHours) {
  const map = {};
  for (const bh of businessHours || []) {
    if (!bh || bh.isOpen === false) continue;
    const full = DAY_ALIASES[bh.day] || bh.day;
    const idx = DAY_KEYS.indexOf(full);
    if (idx < 0) continue;
    map[idx] = {
      open: hmToMinutes(bh.openTime || "09:00"),
      close: hmToMinutes(bh.closeTime || "18:00"),
    };
  }
  return map;
}

/** A short human label like "Mon, 12 Aug · 2:30 PM" in the workspace tz. */
function slotLabel(date, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/**
 * Compute the next available slots.
 *
 * @param {object} workspace  full workspace doc (needs appointments + businessHours + timezone)
 * @param {object} opts
 * @param {Date}   [opts.from]        start searching from this instant (default now)
 * @param {string} [opts.service]     service name (uses its duration if found)
 * @param {number} [opts.limit]       max slots to return (default 8)
 * @returns {Promise<Array<{ startAt: Date, endAt: Date, label: string, service: string, durationMinutes: number }>>}
 */
async function getAvailableSlots(workspace, opts = {}) {
  const cfg = workspace.appointments || {};
  if (!cfg.enabled) return [];

  const tz = workspace.timezone || "Asia/Karachi";
  const now = opts.from instanceof Date ? opts.from : new Date();
  const limit = Math.min(opts.limit || 8, 30);

  const services = Array.isArray(cfg.services) ? cfg.services : [];
  const svc =
    (opts.service &&
      services.find(
        (s) =>
          s.name &&
          s.name.toLowerCase().trim() ===
            String(opts.service).toLowerCase().trim(),
      )) ||
    null;
  const duration =
    (svc && svc.durationMinutes) || cfg.slotMinutes || 30;
  const step = cfg.slotMinutes || duration || 30;
  const buffer = cfg.bufferMinutes || 0;
  const capacity = Math.max(1, cfg.capacityPerSlot || 1);
  const advanceDays = cfg.advanceDays || 30;
  const minNoticeMs = (cfg.minNoticeHours || 0) * 60 * 60 * 1000;
  const earliest = new Date(now.getTime() + minNoticeMs);

  const hmap = hoursMap(workspace.businessHours);
  if (!Object.keys(hmap).length) return []; // no open days configured

  // Pull existing bookings in the window so we never offer a taken slot.
  const Appointment = require("../../models/Appointment");
  const windowEnd = new Date(
    now.getTime() + advanceDays * 24 * 60 * 60 * 1000,
  );
  const booked = await Appointment.find({
    workspaceId: workspace._id,
    status: { $in: ["pending", "confirmed"] },
    startAt: { $gte: now, $lte: windowEnd },
  })
    .select("startAt endAt")
    .lean();

  // Count how many active bookings overlap a candidate [start,end).
  const overlaps = (start, end) =>
    booked.filter(
      (b) =>
        new Date(b.startAt).getTime() < end.getTime() &&
        new Date(b.endAt).getTime() > start.getTime(),
    ).length;

  const slots = [];
  // Walk day by day in workspace-local time.
  for (let dayOffset = 0; dayOffset <= advanceDays && slots.length < limit; dayOffset++) {
    // Local calendar date for this offset.
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const lp = partsInTz(probe, tz);
    const dayHours = hmap[lp.weekday];
    if (!dayHours) continue; // closed that day

    // Generate candidate start times across the open window.
    for (
      let mins = dayHours.open;
      mins + duration <= dayHours.close && slots.length < limit;
      mins += step + buffer
    ) {
      const h = Math.floor(mins / 60);
      const mi = mins % 60;
      const startAt = wallClockToUtc(lp.year, lp.month, lp.day, h, mi, tz);
      if (startAt.getTime() < earliest.getTime()) continue; // too soon / past
      const endAt = new Date(startAt.getTime() + duration * 60000);
      if (overlaps(startAt, endAt) >= capacity) continue; // full

      slots.push({
        startAt,
        endAt,
        label: slotLabel(startAt, tz),
        service: svc ? svc.name : opts.service || "",
        durationMinutes: duration,
      });
    }
  }
  return slots;
}

/**
 * Validate a specific requested start time — used before persisting a booking
 * the AI captured, so a hallucinated or now-taken slot is rejected cleanly.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, endAt?: Date, durationMinutes?: number }>}
 */
async function isSlotAvailable(workspace, startAt, service) {
  const cfg = workspace.appointments || {};
  if (!cfg.enabled) return { ok: false, reason: "scheduling_disabled" };

  const tz = workspace.timezone || "Asia/Karachi";
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  if (isNaN(start.getTime())) return { ok: false, reason: "invalid_time" };

  const now = new Date();
  const minNoticeMs = (cfg.minNoticeHours || 0) * 60 * 60 * 1000;
  if (start.getTime() < now.getTime() + minNoticeMs)
    return { ok: false, reason: "too_soon" };

  const advanceMs = (cfg.advanceDays || 30) * 24 * 60 * 60 * 1000;
  if (start.getTime() > now.getTime() + advanceMs)
    return { ok: false, reason: "too_far" };

  const services = Array.isArray(cfg.services) ? cfg.services : [];
  const svc =
    (service &&
      services.find(
        (s) =>
          s.name &&
          s.name.toLowerCase().trim() ===
            String(service).toLowerCase().trim(),
      )) ||
    null;
  const duration = (svc && svc.durationMinutes) || cfg.slotMinutes || 30;
  const end = new Date(start.getTime() + duration * 60000);

  // Must fall inside open business hours for that local day.
  const lp = partsInTz(start, tz);
  const hmap = hoursMap(workspace.businessHours);
  const dayHours = hmap[lp.weekday];
  if (!dayHours) return { ok: false, reason: "closed_day" };
  const startMins = lp.hour * 60 + lp.minute;
  if (startMins < dayHours.open || startMins + duration > dayHours.close)
    return { ok: false, reason: "outside_hours" };

  // Capacity check against existing bookings.
  const capacity = Math.max(1, cfg.capacityPerSlot || 1);
  const Appointment = require("../../models/Appointment");
  const conflicts = await Appointment.countDocuments({
    workspaceId: workspace._id,
    status: { $in: ["pending", "confirmed"] },
    startAt: { $lt: end },
    endAt: { $gt: start },
  });
  if (conflicts >= capacity) return { ok: false, reason: "slot_taken" };

  return { ok: true, endAt: end, durationMinutes: duration, service: svc ? svc.name : service || "" };
}

module.exports = {
  getAvailableSlots,
  isSlotAvailable,
  // exported for testing / reuse
  partsInTz,
  wallClockToUtc,
  slotLabel,
};
