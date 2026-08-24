const asyncHandler = require("express-async-handler");
const Property = require("../models/Property");
const RoomType = require("../models/RoomType");
const HotelBooking = require("../models/HotelBooking");
const channexService = require("../services/channels/channexService");
const {
  createBooking,
  cancelBooking,
} = require("../services/hotel/bookingService");
const {
  nightlyAvailability,
  getAvailableUnits,
  toDay,
} = require("../services/hotel/availability");
const logger = require("../utils/logger");

// ─── Properties ─────────────────────────────────────────────────────────────

// @GET /api/hotel/properties
const listProperties = asyncHandler(async (req, res) => {
  const properties = await Property.find({
    workspaceId: req.workspace._id,
  }).sort({ createdAt: 1 });
  res.json({ success: true, properties });
});

// @POST /api/hotel/properties — manual create (no OTA import)
const createProperty = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.name) {
    res.status(400);
    throw new Error("Property name is required");
  }

  // Properties are billed individually, so the plan caps how many a workspace
  // can run. Checked here rather than in the UI so it holds for API callers too.
  const { getPlan } = require("../config/plans");
  const limit = getPlan(req.workspace.subscription?.plan)?.limits?.properties;
  if (limit && limit > 0) {
    const existing = await Property.countDocuments({
      workspaceId: req.workspace._id,
      active: true,
    });
    if (existing >= limit) {
      res.status(403);
      throw new Error(
        `Your plan covers ${limit} propert${limit === 1 ? "y" : "ies"}. ` +
          "Upgrade to add another.",
      );
    }
  }
  const property = await Property.create({
    workspaceId: req.workspace._id,
    name: b.name,
    description: b.description || "",
    propertyType: b.propertyType || "hotel",
    address: b.address || "",
    city: b.city || "",
    country: b.country || "",
    timezone: b.timezone || req.workspace.timezone || "Asia/Makassar",
    currency: b.currency || "USD",
    checkInTime: b.checkInTime || "14:00",
    checkOutTime: b.checkOutTime || "11:00",
    phone: b.phone || "",
    email: b.email || "",
    photos: Array.isArray(b.photos)
      ? b.photos.map((p, i) =>
          typeof p === "string" ? { url: p, position: i } : p,
        )
      : [],
    transfers: b.transfers || {},
  });
  res.status(201).json({ success: true, property });
});

// @PUT /api/hotel/properties/:id
const updateProperty = asyncHandler(async (req, res) => {
  const allowed = [
    "name",
    "description",
    "propertyType",
    "address",
    "city",
    "state",
    "country",
    "zipCode",
    "timezone",
    "currency",
    "checkInTime",
    "checkOutTime",
    "policies",
    "phone",
    "email",
    "photos",
    "amenities",
    "starRating",
    "transfers",
    "active",
  ];
  // Nested field: the OTAs the hotel says they're listed on (intent, not state).
  if (Array.isArray(req.body.requestedOtas)) {
    req.body["channel.requestedOtas"] = req.body.requestedOtas
      .filter((v) => typeof v === "string")
      .slice(0, 60);
    allowed.push("channel.requestedOtas");
  }
  const update = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) update[k] = req.body[k];
  }
  const property = await Property.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { $set: update },
    { new: true },
  );
  if (!property) {
    res.status(404);
    throw new Error("Property not found");
  }
  res.json({ success: true, property });
});

// ─── Channex connect / import ───────────────────────────────────────────────

// @GET /api/hotel/channex/properties — properties visible on our Channex key
// that aren't imported into a workspace yet (onboarding picker).
const listChannexProperties = asyncHandler(async (req, res) => {
  if (!channexService.isConfigured()) {
    res.status(503);
    throw new Error(
      "OTA sync isn't configured yet. Add your rooms manually for now.",
    );
  }
  const [remote, local] = await Promise.all([
    channexService.listProperties(),
    Property.find({ "channel.channexPropertyId": { $ne: null } })
      .select("channel.channexPropertyId")
      .lean(),
  ]);
  const taken = new Set(local.map((p) => p.channel.channexPropertyId));
  res.json({
    success: true,
    properties: remote.map((p) => ({
      channexId: p.id,
      name: p.title || p.name,
      city: p.city,
      country: p.country,
      currency: p.currency,
      alreadyImported: taken.has(p.id),
    })),
  });
});

// @POST /api/hotel/channex/import — { channexPropertyId } → import content
// (property, rooms, photos) and register the reservation webhook.
const importChannexProperty = asyncHandler(async (req, res) => {
  const { channexPropertyId } = req.body;
  if (!channexPropertyId) {
    res.status(400);
    throw new Error("channexPropertyId is required");
  }
  const existing = await Property.findOne({
    "channel.channexPropertyId": channexPropertyId,
    workspaceId: { $ne: req.workspace._id },
  });
  if (existing) {
    res.status(409);
    throw new Error("This property is already connected to another account.");
  }
  const { property, roomTypes } = await channexService.importProperty(
    req.workspace._id,
    channexPropertyId,
  );
  try {
    await channexService.registerWebhook(channexPropertyId);
  } catch (err) {
    logger.warn("[hotel] channex webhook registration failed", {
      err: err.message,
    });
  }
  res.json({ success: true, property, roomTypes });
});

// ─── Room types ─────────────────────────────────────────────────────────────

// @GET /api/hotel/properties/:id/rooms
const listRoomTypes = asyncHandler(async (req, res) => {
  const roomTypes = await RoomType.find({
    propertyId: req.params.id,
    workspaceId: req.workspace._id,
  }).sort({ createdAt: 1 });
  res.json({ success: true, roomTypes });
});

// @POST /api/hotel/properties/:id/rooms
const createRoomType = asyncHandler(async (req, res) => {
  const property = await Property.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!property) {
    res.status(404);
    throw new Error("Property not found");
  }
  const b = req.body || {};
  if (!b.name) {
    res.status(400);
    throw new Error("Room name is required");
  }
  const roomType = await RoomType.create({
    workspaceId: req.workspace._id,
    propertyId: property._id,
    name: b.name,
    description: b.description || "",
    unitsCount: Math.max(1, Number(b.unitsCount) || 1),
    maxAdults: Number(b.maxAdults) || 2,
    maxChildren: Number(b.maxChildren) || 0,
    maxOccupancy:
      Number(b.maxOccupancy) ||
      (Number(b.maxAdults) || 2) + (Number(b.maxChildren) || 0),
    bedConfig: b.bedConfig || "",
    baseRate: Number(b.baseRate) || 0,
    currency: b.currency || property.currency || "USD",
    amenities: Array.isArray(b.amenities) ? b.amenities : [],
    photos: Array.isArray(b.photos)
      ? b.photos.map((p, i) =>
          typeof p === "string" ? { url: p, position: i } : p,
        )
      : [],
  });
  res.status(201).json({ success: true, roomType });
});

// @PUT /api/hotel/rooms/:roomId
const updateRoomType = asyncHandler(async (req, res) => {
  const allowed = [
    "name",
    "description",
    "unitsCount",
    "maxAdults",
    "maxChildren",
    "maxOccupancy",
    "bedConfig",
    "baseRate",
    "currency",
    "amenities",
    "photos",
    "active",
    "sizeSqm",
  ];
  const update = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) update[k] = req.body[k];
  }
  const roomType = await RoomType.findOneAndUpdate(
    { _id: req.params.roomId, workspaceId: req.workspace._id },
    { $set: update },
    { new: true },
  );
  if (!roomType) {
    res.status(404);
    throw new Error("Room not found");
  }
  res.json({ success: true, roomType });
});

// ─── Availability ───────────────────────────────────────────────────────────

// @GET /api/hotel/rooms/:roomId/availability?from=2026-09-01&days=30
const roomAvailability = asyncHandler(async (req, res) => {
  const roomType = await RoomType.findOne({
    _id: req.params.roomId,
    workspaceId: req.workspace._id,
  });
  if (!roomType) {
    res.status(404);
    throw new Error("Room not found");
  }
  const from = toDay(req.query.from) || toDay(new Date());
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const nights = await nightlyAvailability(roomType, from, days);
  res.json({ success: true, unitsCount: roomType.unitsCount, nights });
});

// @GET /api/hotel/rooms/:roomId/check?checkIn=..&checkOut=..
const checkRange = asyncHandler(async (req, res) => {
  const roomType = await RoomType.findOne({
    _id: req.params.roomId,
    workspaceId: req.workspace._id,
  });
  if (!roomType) {
    res.status(404);
    throw new Error("Room not found");
  }
  const result = await getAvailableUnits(
    roomType,
    req.query.checkIn,
    req.query.checkOut,
  );
  res.json({ success: true, ...result });
});

// ─── Bookings ───────────────────────────────────────────────────────────────

// @GET /api/hotel/bookings?status=&source=&from=&to=&page=
const listBookings = asyncHandler(async (req, res) => {
  const q = { workspaceId: req.workspace._id };
  if (req.query.status) q.status = req.query.status;
  if (req.query.source) q.source = req.query.source;
  if (req.query.propertyId) q.propertyId = req.query.propertyId;
  if (req.query.from || req.query.to) {
    q.checkIn = {};
    if (req.query.from) q.checkIn.$gte = toDay(req.query.from);
    if (req.query.to) q.checkIn.$lte = toDay(req.query.to);
  }
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 25);
  const [bookings, total] = await Promise.all([
    HotelBooking.find(q)
      .sort({ checkIn: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("roomTypeId", "name")
      .populate("propertyId", "name"),
    HotelBooking.countDocuments(q),
  ]);
  res.json({ success: true, bookings, total, page, pages: Math.ceil(total / limit) });
});

// @POST /api/hotel/bookings — manual booking from the dashboard
const createManualBooking = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const result = await createBooking({
    workspace: req.workspace,
    propertyId: b.propertyId,
    roomTypeId: b.roomTypeId,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    guestName: b.guestName,
    guestPhone: b.guestPhone,
    guestEmail: b.guestEmail,
    adults: Number(b.adults) || 2,
    children: Number(b.children) || 0,
    unitsBooked: Math.max(1, Number(b.unitsBooked) || 1),
    source: "manual",
    specialRequests: b.specialRequests || "",
    nightlyRate: b.nightlyRate !== undefined ? Number(b.nightlyRate) : null,
  });
  if (!result.ok) {
    res.status(400);
    throw new Error(`Could not create booking: ${result.reason}`);
  }
  res.status(201).json({ success: true, booking: result.booking });
});

// @PATCH /api/hotel/bookings/:id/status — { status, reason? }
const updateBookingStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  if (status === "cancelled") {
    const result = await cancelBooking(req.params.id, {
      reason: reason || "cancelled from dashboard",
      workspaceId: req.workspace._id,
    });
    if (!result.ok) {
      res.status(404);
      throw new Error("Booking not found");
    }
    return res.json({ success: true, booking: result.booking });
  }
  if (!["confirmed", "completed", "no_show", "pending"].includes(status)) {
    res.status(400);
    throw new Error("Invalid status");
  }
  const booking = await HotelBooking.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { $set: { status } },
    { new: true },
  );
  if (!booking) {
    res.status(404);
    throw new Error("Booking not found");
  }
  res.json({ success: true, booking });
});

// ─── Channex inbound webhook (public route) ─────────────────────────────────

// @POST /api/channex/webhook?token=...
const handleChannexWebhook = asyncHandler(async (req, res) => {
  if (!channexService.verifyWebhookToken(req.query.token)) {
    logger.warn("[Channex webhook] bad token — dropping");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast, process async

  const payload = req.body || {};
  const event = String(payload.event || payload.event_type || "").toLowerCase();
  logger.info(`[Channex webhook] event=${event}`);
  if (
    event.includes("booking") ||
    payload?.payload?.booking_id ||
    payload?.booking_id
  ) {
    try {
      await channexService.handleBookingEvent(payload);
    } catch (err) {
      logger.error("[Channex webhook] processing failed", { err: err.message });
    }
  }
});

module.exports = {
  listProperties,
  createProperty,
  updateProperty,
  listChannexProperties,
  importChannexProperty,
  listRoomTypes,
  createRoomType,
  updateRoomType,
  roomAvailability,
  checkRange,
  listBookings,
  createManualBooking,
  updateBookingStatus,
  handleChannexWebhook,
};
