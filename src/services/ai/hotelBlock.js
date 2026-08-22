/**
 * hotelBlock.js — hotel-booking prompt block for the AI concierge.
 *
 * Mirrors buildAppointmentBlock: precomputed in generateReply (needs live DB
 * availability) and injected into the system prompt so the bot only ever
 * offers real, bookable stays. Returns "" unless the workspace has hotel
 * bookings enabled AND at least one active property with active rooms.
 */
const logger = require("../../utils/logger");

/** "Sep 3" — compact day label for availability ranges (UTC calendar days). */
const fmtDay = (d) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);

const buildHotelBlock = async (workspace) => {
  if (!workspace.features?.hotelBookings) return "";

  let property = null;
  let roomTypes = [];
  let summary = [];
  try {
    // Models required lazily so this module stays free of load-order issues.
    const Property = require("../../models/Property");
    const RoomType = require("../../models/RoomType");
    property = await Property.findOne({
      workspaceId: workspace._id,
      active: true,
    }).lean();
    if (!property) return "";
    roomTypes = await RoomType.find({
      workspaceId: workspace._id,
      propertyId: property._id,
      active: true,
    }).lean();
    if (!roomTypes.length) return ""; // nothing bookable yet
    const { summarizeAvailability } = require("../hotel/availability");
    summary = await summarizeAvailability(roomTypes, { days: 30 });
  } catch (e) {
    logger.warn("[AI] hotel block build failed", { err: e.message });
    return "";
  }

  const place = [property.city, property.country].filter(Boolean).join(", ");
  const out = [
    "─── HOTEL BOOKING MODE ───",
    `You are the booking concierge for ${property.name}${place ? ` (${place})` : ""}. Help guests book real stays using ONLY the rooms and availability listed below. Never invent rooms, prices, or availability that isn't listed.`,
    "",
    "PROPERTY:",
    `  • ${property.name}${place ? ` — ${place}` : ""}`,
    `  • Check-in from ${property.checkInTime || "14:00"}, check-out by ${property.checkOutTime || "11:00"}`,
  ];
  if (property.policies && property.policies.trim()) {
    out.push(`  • Policies: ${property.policies.trim().slice(0, 500)}`);
  }

  out.push(
    "",
    "ROOMS (the [rt:...] bracket is the machine id of the room — machine-only, NEVER show it to guests):",
  );
  roomTypes.forEach((rt) => {
    const bits = [`  • ${rt.name}`];
    if (rt.bedConfig) bits.push(`— ${rt.bedConfig}`);
    bits.push(`— sleeps ${rt.maxOccupancy || 2}`);
    bits.push(`— ${rt.currency || property.currency || "USD"} ${rt.baseRate || 0}/night`);
    bits.push(`[rt:${rt._id}]`);
    out.push(bits.join(" "));
  });

  out.push(
    "",
    "AVAILABILITY (next 30 days — ranges of free NIGHTS; the guest checks out the day AFTER their last night):",
  );
  let anyAvailable = false;
  summary.forEach(({ roomType, ranges }) => {
    if (!ranges.length) {
      out.push(`  • ${roomType.name}: fully booked for the next 30 days`);
      return;
    }
    anyAvailable = true;
    const parts = ranges.map((r) => {
      const span =
        r.from.getTime() === r.to.getTime()
          ? fmtDay(r.from)
          : `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
      // Flag scarcity only when some units in the range are already taken.
      return r.minAvailable < (roomType.unitsCount || 1)
        ? `${span} (${r.minAvailable} left)`
        : span;
    });
    out.push(`  • ${roomType.name}: ${parts.join(", ")}`);
  });
  if (!anyAvailable) {
    out.push(
      "  Everything is fully booked right now — apologise warmly, offer to take the guest's name + phone so the team can follow up when dates open, and NEVER book anyway.",
    );
  }

  // Airport transfers — own service beats partner service.
  const transfers = property.transfers || {};
  if (transfers.hasOwnService) {
    out.push(
      "",
      "TRANSFERS:",
      `  • We run our own airport pickup${transfers.ownServicePrice ? ` — ${property.currency || "USD"} ${transfers.ownServicePrice}` : ""}.${transfers.ownServiceNotes ? ` ${transfers.ownServiceNotes.trim()}` : ""}`,
      "  • If the guest wants pickup, collect their flight number and arrival time.",
    );
  } else if (transfers.offerPartnerService) {
    out.push(
      "",
      "TRANSFERS:",
      "  • We can arrange an airport transfer through a trusted partner. If the guest is interested, collect their flight number and arrival time and tell them we'll confirm the price.",
    );
  }

  out.push(
    "",
    "TO BOOK A STAY: collect the room choice, exact check-in and check-out dates, guest name, phone, and number of adults/children. Ask 1–2 things at a time, conversationally — never a form. Only offer dates inside the listed availability.",
    "When EVERYTHING is collected, emit ONCE on its own line (never shown to the guest):",
    '<<BOOK_STAY_JSON>>{"roomTypeId":"<id from the room\'s [rt:...] bracket>","checkIn":"YYYY-MM-DD","checkOut":"YYYY-MM-DD","guestName":"<full name>","guestPhone":"<phone>","adults":2,"children":0,"specialRequests":""}<<END_STAY>>',
    "For a transfer request, emit ONCE on its own line:",
    '<<BOOK_TRANSFER_JSON>>{"direction":"pickup","pickupAt":"<ISO datetime of arrival>","flightNumber":"<flight no>","guestName":"<full name>","guestPhone":"<phone>","passengers":2}<<END_TRANSFER>>',
    "Write a warm confirmation ABOVE the block: the room, the dates, and the total price (nightly rate × number of nights).",
    "─── END HOTEL BOOKING ───",
  );
  return out.join("\n");
};

module.exports = { buildHotelBlock };
