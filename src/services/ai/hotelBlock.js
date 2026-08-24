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

  // House rules — guests ask these by name, so give the model the facts rather
  // than making it paraphrase a policy paragraph.
  const r = property.rules || {};
  const rules = [];
  if (r.childrenWelcome === false) rules.push("no children");
  else if (r.childAgeLimit) {
    rules.push(`children welcome (charged as adults from age ${r.childAgeLimit})`);
  }
  if (r.cotsAvailable) {
    rules.push(`cots available${r.cotPrice ? ` (${r.cotPrice} per night)` : " free"}`);
  }
  rules.push(r.petsAllowed
    ? `pets allowed${r.petFee ? ` (${r.petFee} fee)` : ""}`
    : "no pets");
  rules.push(r.smokingAllowed ? "smoking allowed" : "no smoking");
  if (r.partiesAllowed === false) rules.push("no parties or events");
  if (r.quietHours) rules.push(`quiet hours ${r.quietHours}`);
  if (r.minAge) rules.push(`minimum check-in age ${r.minAge}`);
  if (rules.length) out.push(`  • House rules: ${rules.join(", ")}`);

  // How they can pay — the AI should be able to answer this outright.
  const pm = property.paymentMethods || {};
  const pays = [];
  if (pm.cash) pays.push("cash");
  if (pm.card) pays.push("card");
  if (pm.bankTransfer) pays.push("bank transfer");
  if (pm.qris) pays.push("QRIS");
  if (pm.eWallet) pays.push("e-wallet (GoPay/OVO/DANA)");
  if (pays.length) {
    out.push(
      `  • Payment accepted: ${pays.join(", ")}` +
        (pm.payAtProperty ? " — payable at the property" : "") +
        (pm.depositRequired && pm.depositPercent
          ? `. A ${pm.depositPercent}% deposit is required to confirm.`
          : ""),
    );
  }

  out.push(
    "",
    "ROOMS (the [rt:...] bracket is the machine id of the room — machine-only, NEVER show it to guests):",
  );
  roomTypes.forEach((rt) => {
    const cur = rt.currency || property.currency || "USD";
    const bits = [`  • ${rt.name}`];
    if (rt.bedConfig) bits.push(`— ${rt.bedConfig}`);
    bits.push(`— sleeps ${rt.maxOccupancy || 2}`);
    // Price, including how extra guests are charged (a family must not be
    // quoted the two-person rate).
    let price = `— ${cur} ${rt.baseRate || 0}/night`;
    if (rt.baseOccupancy) price += ` for ${rt.baseOccupancy} guests`;
    if (rt.extraGuestFee) {
      price += `, +${cur} ${rt.extraGuestFee} per extra guest per night`;
    }
    bits.push(price);
    if (rt.bathroom && rt.bathroom !== "private") {
      bits.push(`— ${rt.bathroom} bathroom`);
    }
    // Breakfast and cancellation are the two most-asked questions after price.
    const bf = rt.breakfast || {};
    if (bf.included) bits.push("— breakfast included");
    else if (bf.price) bits.push(`— breakfast ${cur} ${bf.price} per person`);
    const cx = rt.cancellation || {};
    if (cx.policy === "non_refundable") bits.push("— non-refundable");
    else if (cx.policy === "flexible") bits.push("— free cancellation any time");
    else if (cx.freeUntilDays !== undefined) {
      bits.push(
        `— free cancellation until ${cx.freeUntilDays} day${
          cx.freeUntilDays === 1 ? "" : "s"
        } before check-in`,
      );
    }
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
