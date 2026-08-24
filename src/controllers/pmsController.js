/**
 * pmsController — PMS-lite: the front desk on a phone.
 *
 * Three things a small hotel does every single day: see who's arriving and
 * leaving, check them in and out, and know which rooms are dirty. Everything
 * else is a spreadsheet they already have.
 */
const asyncHandler = require("express-async-handler");
const Property = require("../models/Property");
const RoomType = require("../models/RoomType");
const HotelBooking = require("../models/HotelBooking");
const { toDay, DAY_MS } = require("../services/hotel/availability");
const { getDemandSummary } = require("../services/revenue/demandService");
const logger = require("../utils/logger");

const HOUSEKEEPING_STATUSES = ["clean", "dirty", "inspected", "out_of_service"];

/**
 * A room type's units, auto-generated "1".."N" on first use.
 * Hotels never set this up in advance — the first time someone taps a room on
 * the housekeeping board, the board builds itself from unitsCount.
 */
function ensureUnits(roomType) {
  if (roomType.units && roomType.units.length) return false;
  const count = roomType.unitsCount || 1;
  roomType.units = [];
  for (let i = 1; i <= count; i++) {
    roomType.units.push({
      label: String(i),
      housekeeping: "clean",
      note: "",
      updatedAt: new Date(),
    });
  }
  return true;
}

/**
 * Resolve which property a request is about.
 *
 * A workspace can hold several properties (a group with three villas is one
 * account). The client passes ?propertyId=... to pick one; without it we fall
 * back to the oldest active property so single-property hotels — the common
 * case — never have to think about it.
 */
async function getProperty(workspaceId, propertyId = null) {
  if (propertyId) {
    const chosen = await Property.findOne({
      _id: propertyId,
      workspaceId,
      active: true,
    });
    if (chosen) return chosen;
    // Fall through when the id is bogus or belongs to another workspace, so a
    // stale id in the UI degrades to the default rather than erroring.
  }
  return Property.findOne({ workspaceId, active: true }).sort({ createdAt: 1 });
}

// ─── Today ──────────────────────────────────────────────────────────────────

// @GET /api/pms/today
const today = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const day = toDay(new Date());
  const tomorrow = new Date(day.getTime() + DAY_MS);

  const [arrivals, departures, inHouse, roomTypes] = await Promise.all([
    // Arriving today and not yet cancelled.
    HotelBooking.find({
      workspaceId,
      status: { $in: ["pending", "confirmed"] },
      checkIn: { $gte: day, $lt: tomorrow },
    })
      .populate("roomTypeId", "name")
      .sort({ checkIn: 1 })
      .lean(),
    // Leaving today (still checked in, or due out).
    HotelBooking.find({
      workspaceId,
      status: { $in: ["pending", "confirmed"] },
      checkOut: { $gte: day, $lt: tomorrow },
    })
      .populate("roomTypeId", "name")
      .sort({ checkOut: 1 })
      .lean(),
    // Staying tonight: arrived on or before today, leaving after today.
    HotelBooking.find({
      workspaceId,
      status: { $in: ["pending", "confirmed"] },
      checkIn: { $lte: day },
      checkOut: { $gt: tomorrow },
    })
      .populate("roomTypeId", "name")
      .sort({ unitLabel: 1 })
      .lean(),
    RoomType.find({ workspaceId, active: true }).lean(),
  ]);

  // Housekeeping board — flattened across room types.
  const housekeeping = [];
  let totalUnits = 0;
  for (const rt of roomTypes) {
    totalUnits += rt.unitsCount || 1;
    const units =
      rt.units && rt.units.length
        ? rt.units
        : Array.from({ length: rt.unitsCount || 1 }, (_, i) => ({
            label: String(i + 1),
            housekeeping: "clean",
            note: "",
          }));
    for (const u of units) {
      housekeeping.push({
        roomTypeId: rt._id,
        roomName: rt.name,
        unit: u.label,
        status: u.housekeeping || "clean",
        note: u.note || "",
      });
    }
  }

  // Occupancy tonight: units sold for the night of `day`.
  const occupiedAgg = await HotelBooking.aggregate([
    {
      $match: {
        workspaceId,
        status: { $in: ["pending", "confirmed"] },
        checkIn: { $lte: day },
        checkOut: { $gt: day },
      },
    },
    { $group: { _id: null, units: { $sum: "$unitsBooked" } } },
  ]);
  const occupied = occupiedAgg[0] ? occupiedAgg[0].units : 0;
  const occupancyPct = totalUnits
    ? Math.round(Math.min(1, occupied / totalUnits) * 100)
    : 0;

  res.json({
    success: true,
    date: day,
    arrivals,
    departures,
    inHouse,
    housekeeping,
    occupancyPct,
    unitsTotal: totalUnits,
    unitsOccupied: occupied,
  });
});

// ─── Check-in / check-out ───────────────────────────────────────────────────

/** Load a booking for this workspace or 404. */
async function loadBooking(req, res) {
  const booking = await HotelBooking.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!booking) {
    res.status(404);
    throw new Error("Booking not found");
  }
  return booking;
}

// @POST /api/pms/bookings/:id/check-in
const checkIn = asyncHandler(async (req, res) => {
  const booking = await loadBooking(req, res);
  if (booking.status === "cancelled") {
    res.status(400);
    throw new Error("This booking was cancelled");
  }
  if (booking.checkedOutAt) {
    res.status(400);
    throw new Error("This guest has already checked out");
  }

  const unitLabel = String(req.body?.unitLabel || "").trim();
  if (unitLabel) booking.unitLabel = unitLabel;
  if (!booking.checkedInAt) booking.checkedInAt = new Date();
  if (booking.status === "pending") booking.status = "confirmed";
  await booking.save();

  logger.info(
    `[pms] check-in ws=${req.workspace._id} code=${booking.code} unit=${booking.unitLabel || "-"}`,
  );
  res.json({ success: true, booking });
});

// @POST /api/pms/bookings/:id/check-out
const checkOut = asyncHandler(async (req, res) => {
  const booking = await loadBooking(req, res);
  if (booking.status === "cancelled") {
    res.status(400);
    throw new Error("This booking was cancelled");
  }

  if (!booking.checkedOutAt) booking.checkedOutAt = new Date();
  booking.status = "completed";
  await booking.save();

  // The room they just left is dirty — that's the whole housekeeping loop.
  if (booking.unitLabel) {
    try {
      const roomType = await RoomType.findOne({
        _id: booking.roomTypeId,
        workspaceId: req.workspace._id,
      });
      if (roomType) {
        ensureUnits(roomType);
        const unit = roomType.units.find((u) => u.label === booking.unitLabel);
        if (unit) {
          unit.housekeeping = "dirty";
          unit.updatedAt = new Date();
          await roomType.save();
        }
      }
    } catch (err) {
      logger.warn(`[pms] housekeeping flag failed: ${err.message}`);
    }
  }

  const folioTotal =
    Math.round(
      (booking.folio || []).reduce(
        (a, l) => a + (l.amount || 0) * (l.quantity || 1),
        0,
      ) * 100,
    ) / 100;
  const roomCharge = booking.totalAmount || 0;

  logger.info(
    `[pms] check-out ws=${req.workspace._id} code=${booking.code} total=${roomCharge + folioTotal}`,
  );
  res.json({
    success: true,
    booking,
    roomCharge,
    folioTotal,
    grandTotal: Math.round((roomCharge + folioTotal) * 100) / 100,
    currency: booking.currency || "USD",
  });
});

// ─── Folio ──────────────────────────────────────────────────────────────────

// @POST /api/pms/bookings/:id/folio
const addFolioLine = asyncHandler(async (req, res) => {
  const booking = await loadBooking(req, res);
  const label = String(req.body?.label || "").trim();
  const amount = Number(req.body?.amount);
  const quantity =
    req.body?.quantity === undefined ? 1 : Math.floor(Number(req.body.quantity));

  if (!label) {
    res.status(400);
    throw new Error("A charge needs a label");
  }
  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400);
    throw new Error("Amount must be a positive number");
  }
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 999) {
    res.status(400);
    throw new Error("Quantity must be between 1 and 999");
  }

  booking.folio.push({ label, amount, quantity, addedAt: new Date() });
  await booking.save();
  res.status(201).json({ success: true, folio: booking.folio });
});

// @DELETE /api/pms/bookings/:id/folio/:lineId
const removeFolioLine = asyncHandler(async (req, res) => {
  const booking = await loadBooking(req, res);
  const line = booking.folio.id(req.params.lineId);
  if (!line) {
    res.status(404);
    throw new Error("Charge not found");
  }
  line.deleteOne();
  await booking.save();
  res.json({ success: true, folio: booking.folio });
});

// ─── Housekeeping ───────────────────────────────────────────────────────────

// @GET /api/pms/units
const listUnits = asyncHandler(async (req, res) => {
  const roomTypes = await RoomType.find({
    workspaceId: req.workspace._id,
    active: true,
  }).sort({ name: 1 });

  const rooms = [];
  for (const rt of roomTypes) {
    // Materialize on read so the board is never empty on first open.
    if (ensureUnits(rt)) await rt.save();
    rooms.push({
      roomTypeId: rt._id,
      roomName: rt.name,
      units: rt.units.map((u) => ({
        label: u.label,
        status: u.housekeeping || "clean",
        note: u.note || "",
        updatedAt: u.updatedAt,
      })),
    });
  }
  res.json({ success: true, rooms });
});

// @PATCH /api/pms/units
const updateUnit = asyncHandler(async (req, res) => {
  const { roomTypeId, unitLabel, status, note } = req.body || {};
  if (!roomTypeId || !unitLabel) {
    res.status(400);
    throw new Error("roomTypeId and unitLabel are required");
  }
  if (!HOUSEKEEPING_STATUSES.includes(status)) {
    res.status(400);
    throw new Error(
      "Status must be one of: " + HOUSEKEEPING_STATUSES.join(", "),
    );
  }

  const roomType = await RoomType.findOne({
    _id: roomTypeId,
    workspaceId: req.workspace._id,
  });
  if (!roomType) {
    res.status(404);
    throw new Error("Room type not found");
  }

  ensureUnits(roomType);
  const label = String(unitLabel).trim();
  let unit = roomType.units.find((u) => u.label === label);
  if (!unit) {
    // A label the hotel uses that isn't in the generated 1..N set ("Villa 2").
    roomType.units.push({ label, housekeeping: status, note: note || "" });
    unit = roomType.units[roomType.units.length - 1];
  } else {
    unit.housekeeping = status;
    if (note !== undefined) unit.note = String(note || "");
  }
  unit.updatedAt = new Date();
  await roomType.save();

  res.json({
    success: true,
    unit: {
      roomTypeId: roomType._id,
      roomName: roomType.name,
      label: unit.label,
      status: unit.housekeeping,
      note: unit.note || "",
      updatedAt: unit.updatedAt,
    },
  });
});

// ─── Direct booking slug ────────────────────────────────────────────────────

// @PUT /api/pms/property/slug — generate (or return) the public page slug.
const propertySlug = asyncHandler(async (req, res) => {
  const property = await getProperty(req.workspace._id, req.query.propertyId);
  if (!property) {
    res.status(404);
    throw new Error("No property set up yet");
  }

  const { ensureSlug } = require("./publicBookingController");
  const slug = await ensureSlug(property);
  if (!slug) {
    res.status(500);
    throw new Error("Could not generate a booking page link");
  }

  const base = process.env.CLIENT_URL || "https://botlify.site";
  res.json({
    success: true,
    slug,
    url: `${base}/book/${slug}`,
    enabled: property.directBooking?.enabled !== false,
  });
});

// ─── Demand ─────────────────────────────────────────────────────────────────

// @GET /api/pms/demand
const demand = asyncHandler(async (req, res) => {
  const property = await getProperty(req.workspace._id, req.query.propertyId);
  if (!property) {
    res.status(404);
    throw new Error("No property set up yet");
  }
  const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 14));
  const result = await getDemandSummary(property, { days });
  res.json({
    success: true,
    summary: result.summary, // null when there aren't enough peer hotels
    days: result.days || [],
  });
});


// ─── Guests ─────────────────────────────────────────────────────────────────

// @GET /api/pms/guests?query=&page=&limit=
// Unified guest profiles — one row per person across every channel and OTA.
const listGuestProfiles = asyncHandler(async (req, res) => {
  const { listGuests } = require("../services/hotel/guestService");
  const result = await listGuests({
    workspaceId: req.workspace._id,
    query: req.query.query || "",
    page: req.query.page,
    limit: req.query.limit,
  });
  res.json({ success: true, ...result });
});

// @GET /api/pms/guests/:id — profile plus their full stay history.
const getGuestProfile = asyncHandler(async (req, res) => {
  const Guest = require("../models/Guest");
  const HotelBooking = require("../models/HotelBooking");
  const guest = await Guest.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  }).lean();
  if (!guest) {
    res.status(404);
    throw new Error("Guest not found");
  }
  // Match their bookings the same way the profile was built: any identity's
  // contact, or the normalized phone/email on the booking itself.
  const { normalizePhone } = require("../services/hotel/guestService");
  const contactIds = (guest.identities || [])
    .map((i) => i.contactId)
    .filter(Boolean);
  const or = [];
  if (contactIds.length) or.push({ contactId: { $in: contactIds } });
  if (guest.email) or.push({ guestEmail: guest.email });
  if (guest.name) or.push({ guestName: guest.name });
  const candidates = or.length
    ? await HotelBooking.find({ workspaceId: req.workspace._id, $or: or })
        .sort({ checkIn: -1 })
        .limit(100)
        .populate("roomTypeId", "name")
        .lean()
    : [];
  // Phone comparison happens in JS because bookings store it as typed.
  const digits = normalizePhone(guest.phone || "");
  const stays = candidates.filter(
    (b) =>
      !digits ||
      !b.guestPhone ||
      normalizePhone(b.guestPhone) === digits ||
      (guest.email && b.guestEmail === guest.email) ||
      (guest.name && b.guestName === guest.name),
  );
  res.json({ success: true, guest, stays });
});

// @POST /api/pms/guests/:id/preferences — { text }
const addGuestPreference = asyncHandler(async (req, res) => {
  const { addPreference } = require("../services/hotel/guestService");
  const text = String(req.body.text || "").trim();
  if (!text) {
    res.status(400);
    throw new Error("Preference text required");
  }
  const guest = await addPreference(req.params.id, text);
  res.json({ success: true, guest });
});

module.exports = {
  listGuestProfiles,
  getGuestProfile,
  addGuestPreference,
  today,
  checkIn,
  checkOut,
  addFolioLine,
  removeFolioLine,
  listUnits,
  updateUnit,
  propertySlug,
  demand,
};
