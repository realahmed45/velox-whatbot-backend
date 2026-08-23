/**
 * demandService — one number the owner actually acts on.
 *
 * "Hotels near you are 82% booked for next weekend" is the whole product here.
 * No dashboard, no charts: just the anonymous share of network rooms sold per
 * day in this property's city, and one sentence about it.
 *
 * Privacy: the same rule revenueService.networkOccupancy uses — below 5 peer
 * properties the number is one hotel's noise (and identifiable), so we return
 * null rather than something misleading.
 */
const { toDay, DAY_MS } = require("../hotel/availability");

const MIN_PEERS = 5;
const ACTIVE_STATUSES = ["pending", "confirmed"];

/**
 * Per-day network occupancy for the property's city over the next `days` days.
 * Aggregated in two queries (not one per day) so the horizon is cheap.
 *
 * @returns {Promise<null|{days: Array<{date, occupancyPct}>, peers, city}>}
 *          null when there aren't enough peers to say anything.
 */
async function getCityDemand(property, { days = 14 } = {}) {
  const Property = require("../../models/Property");
  const RoomType = require("../../models/RoomType");
  const HotelBooking = require("../../models/HotelBooking");
  if (!property || !property.city) return null;

  const peers = await Property.find({
    city: property.city,
    _id: { $ne: property._id },
    active: true,
  })
    .select("_id")
    .limit(200)
    .lean();
  if (peers.length < MIN_PEERS) return null;

  const peerIds = peers.map((p) => p._id);
  const start = toDay(new Date());
  const end = new Date(start.getTime() + days * DAY_MS);

  const [rooms, bookings] = await Promise.all([
    RoomType.aggregate([
      { $match: { propertyId: { $in: peerIds }, active: true } },
      { $group: { _id: null, units: { $sum: "$unitsCount" } } },
    ]),
    // Pull the overlapping bookings once, then bucket them per night locally.
    HotelBooking.find({
      propertyId: { $in: peerIds },
      status: { $in: ACTIVE_STATUSES },
      checkIn: { $lt: end },
      checkOut: { $gt: start },
    })
      .select("checkIn checkOut unitsBooked")
      .lean(),
  ]);

  const totalUnits = rooms[0] && rooms[0].units ? rooms[0].units : 0;
  if (!totalUnits) return null;

  const out = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    let sold = 0;
    for (const b of bookings) {
      if (b.checkIn.getTime() <= t && b.checkOut.getTime() > t) {
        sold += b.unitsBooked || 1;
      }
    }
    out.push({
      date: new Date(t),
      occupancyPct: Math.round(Math.min(1, sold / totalUnits) * 100),
    });
  }

  return { city: property.city, peers: peers.length, days: out };
}

/** Is this day a Fri or Sat night? (the nights people mean by "the weekend") */
function isWeekendNight(date) {
  const d = date.getUTCDay();
  return d === 5 || d === 6;
}

function fmtDay(d) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d);
}

/**
 * The one line. Leads with the weekend when the weekend is the story, otherwise
 * the busiest single night, otherwise the plain average.
 *
 * @returns {Promise<{summary: string|null, days: Array}>}
 */
async function getDemandSummary(property, opts = {}) {
  const demand = await getCityDemand(property, opts);
  if (!demand || !demand.days.length) return { summary: null, days: [] };

  const days = demand.days;
  const avg = Math.round(
    days.reduce((a, d) => a + d.occupancyPct, 0) / days.length,
  );

  const weekend = days.filter((d) => isWeekendNight(d.date)).slice(0, 2);
  const weekendAvg = weekend.length
    ? Math.round(
        weekend.reduce((a, d) => a + d.occupancyPct, 0) / weekend.length,
      )
    : null;

  const peak = days.reduce((a, d) => (d.occupancyPct > a.occupancyPct ? d : a));

  let summary;
  if (weekendAvg !== null && weekendAvg >= avg + 10) {
    summary = `Hotels near you are ${weekendAvg}% booked for the coming weekend.`;
  } else if (peak.occupancyPct >= avg + 15) {
    summary = `Hotels near you are ${peak.occupancyPct}% booked on ${fmtDay(peak.date)} — the busiest night ahead.`;
  } else {
    summary = `Hotels near you are ${avg}% booked over the next ${days.length} days.`;
  }

  return { summary, days, city: demand.city, peers: demand.peers };
}

module.exports = { getCityDemand, getDemandSummary };
