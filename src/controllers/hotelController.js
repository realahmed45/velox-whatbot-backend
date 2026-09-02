const asyncHandler = require("express-async-handler");
const Property = require("../models/Property");
const RoomType = require("../models/RoomType");
const HotelBooking = require("../models/HotelBooking");
const channexService = require("../services/channels/channexService");
const beds24Service = require("../services/channels/beds24Service");
const {
  createBooking,
  cancelBooking,
} = require("../services/hotel/bookingService");
const {
  nightlyAvailability,
  getAvailableUnits,
  toDay,
} = require("../services/hotel/availability");
const {
  evaluateReadiness,
  refreshConnectionState,
} = require("../services/hotel/connectionService");
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
    "rules",
    "paymentMethods",
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

// ─── Beds24 connect / import ────────────────────────────────────────────────

// @GET /api/hotel/beds24/properties — properties visible on our Beds24 token
// that aren't imported into a workspace yet (onboarding picker).
const listBeds24Properties = asyncHandler(async (req, res) => {
  if (!beds24Service.isConfigured()) {
    res.status(503);
    throw new Error(
      "Beds24 sync isn't configured yet. Add your rooms manually for now.",
    );
  }
  const [remote, local] = await Promise.all([
    beds24Service.listProperties(),
    Property.find({ "channel.beds24PropertyId": { $ne: null } })
      .select("channel.beds24PropertyId")
      .lean(),
  ]);
  const taken = new Set(local.map((p) => p.channel.beds24PropertyId));
  res.json({
    success: true,
    properties: remote.map((p) => ({
      beds24Id: String(p.id),
      name: p.name || p.propertyName,
      city: p.city,
      country: p.country,
      currency: p.currency,
      rooms: (p.roomTypes || []).length,
      alreadyImported: taken.has(String(p.id)),
    })),
  });
});

// @POST /api/hotel/beds24/import — { beds24PropertyId } → import content
// (property, rooms). Beds24 booking webhooks can't be registered over API V2,
// so we hand back the callback URL for the owner to paste into their panel;
// the poll job covers them until they do.
const importBeds24Property = asyncHandler(async (req, res) => {
  const { beds24PropertyId } = req.body;
  if (!beds24PropertyId) {
    res.status(400);
    throw new Error("beds24PropertyId is required");
  }
  const existing = await Property.findOne({
    "channel.beds24PropertyId": String(beds24PropertyId),
    workspaceId: { $ne: req.workspace._id },
  });
  if (existing) {
    res.status(409);
    throw new Error("This property is already connected to another account.");
  }
  const { property, roomTypes } = await beds24Service.importProperty(
    req.workspace._id,
    String(beds24PropertyId),
  );
  let webhook = null;
  try {
    webhook = await beds24Service.registerWebhook(String(beds24PropertyId));
  } catch (err) {
    logger.warn("[hotel] beds24 webhook setup failed", { err: err.message });
  }
  res.json({ success: true, property, roomTypes, webhook });
});

// ─── Connection state ───────────────────────────────────────────────────────
//
// One place the UI can ask "where is my OTA connection, really?" — used by the
// onboarding review screen, the Today card and Settings. Deliberately reads
// stored state by default and only hits the provider on an explicit refresh,
// so a screen that polls doesn't hammer the channel manager.

/** The workspace's property — the one named by ?propertyId=, or the first. */
const resolveProperty = async (req) => {
  const q = { workspaceId: req.workspace._id };
  if (req.query.propertyId || req.body?.propertyId) {
    q._id = req.query.propertyId || req.body.propertyId;
  }
  return Property.findOne(q).sort({ createdAt: 1 });
};

/** Shape the state machine for the client, with everything the card needs. */
const connectionPayload = (property, sync, readiness) => ({
  propertyId: property._id,
  propertyName: property.name,
  provider: property.channel?.provider || "none",
  providerConfigured: !!(
    property.channel?.channexPropertyId || property.channel?.beds24PropertyId
  ),
  state: sync?.state || "not_started",
  message: sync?.message || "",
  otaStatus: sync?.otaStatus || [],
  connectedOtas: property.channel?.connectedOtas || [],
  requestedOtas: property.channel?.requestedOtas || [],
  readyToActivate: readiness ? readiness.ready : !!sync?.readyToActivate,
  blockers: readiness ? readiness.blockers : sync?.blockers || [],
  // Lets the card say "Imported — 12 rooms" instead of a bare "Imported".
  roomCount: readiness?.roomCount ?? undefined,
  lastCheckedAt: sync?.lastCheckedAt || null,
  lastSyncAt: property.channel?.lastSyncAt || null,
});

// @GET /api/hotel/connection — stored state + freshly evaluated readiness.
// Readiness is recomputed on every read because it depends on rooms the owner
// may have just edited in another tab; provider state is not, because that
// costs a network call.
const getConnection = asyncHandler(async (req, res) => {
  const property = await resolveProperty(req);
  if (!property) {
    return res.json({
      success: true,
      connection: {
        state: "not_started",
        message: "Add your property to get started.",
        otaStatus: [],
        blockers: [],
        readyToActivate: false,
      },
    });
  }
  const readiness = await evaluateReadiness(property);
  res.json({
    success: true,
    connection: connectionPayload(property, property.channel?.sync, readiness),
  });
});

// @POST /api/hotel/connection/refresh — force a provider re-check (owner).
const refreshConnection = asyncHandler(async (req, res) => {
  const property = await resolveProperty(req);
  if (!property) {
    res.status(404);
    throw new Error("No property to check yet.");
  }
  const sync = await refreshConnectionState(property);
  // Re-read readiness rather than trusting the snapshot: it's cheap, and it
  // carries the room count the card needs.
  const readiness = await evaluateReadiness(property);
  res.json({
    success: true,
    connection: connectionPayload(property, sync, readiness),
  });
});

// ─── Import by OTA id ───────────────────────────────────────────────────────
//
// @POST /api/hotel/connection/import
// body { provider?, otaPropertyId?, providerPropertyId? }
//
// The hotelier's mental model is "my Booking.com hotel ID is 1234567". The
// provider's model is its own property id. When we're given the provider id we
// import directly. When we're only given an OTA id we try to match it against
// what the provider's property list actually exposes — and when that can't be
// done we say so plainly rather than guessing, because importing the WRONG
// hotel is far worse than asking one more question.

/** Which provider to use: the one asked for, else whichever is configured. */
const pickProvider = (requested) => {
  if (requested === "channex") {
    return channexService.isConfigured() ? { name: "channex", svc: channexService } : null;
  }
  if (requested === "beds24") {
    return beds24Service.isConfigured() ? { name: "beds24", svc: beds24Service } : null;
  }
  if (channexService.isConfigured()) return { name: "channex", svc: channexService };
  if (beds24Service.isConfigured()) return { name: "beds24", svc: beds24Service };
  return null;
};

/**
 * Try to find the provider property that corresponds to an OTA property id.
 *
 * What we can honestly match on: an exact id match against the provider's own
 * property id (many hoteliers paste that), and any external/OTA id fields the
 * provider's list payload happens to carry. Neither provider documents a
 * Booking.com hotel-id field, so this frequently returns null — by design, the
 * caller then asks the hotelier to pick from the list instead of us importing
 * a hotel we merely suspect is theirs.
 */
const resolveByOtaId = (list, otaPropertyId, providerName) => {
  const needle = String(otaPropertyId).trim().toLowerCase();
  if (!needle) return null;

  const idOf = (p) => String(providerName === "beds24" ? p.id : p.id ?? "");

  // 1. The id IS the provider id (very common — people paste what they have).
  const direct = list.find((p) => idOf(p).toLowerCase() === needle);
  if (direct) return direct;

  // 2. Any field on the payload that looks like an external/OTA identifier.
  //    Scanned rather than hardcoded because the shape differs per provider
  //    and per how the account was set up.
  const EXTERNAL_KEYS = [
    "external_id",
    "externalId",
    "ota_id",
    "otaId",
    "booking_com_id",
    "bookingComId",
    "hotel_id",
    "hotelId",
    "propertyCode",
    "code",
  ];
  const scan = list.find((p) =>
    EXTERNAL_KEYS.some(
      (k) => p?.[k] != null && String(p[k]).trim().toLowerCase() === needle,
    ),
  );
  return scan || null;
};

const importByConnection = asyncHandler(async (req, res) => {
  const { provider: wanted, otaPropertyId, providerPropertyId } = req.body || {};

  const chosen = pickProvider(wanted);
  if (!chosen) {
    res.status(503);
    throw new Error(
      "Channel sync isn't switched on for your account yet. Add your rooms manually — " +
        "we'll connect your channels for you in the background.",
    );
  }
  const { name, svc } = chosen;

  // Resolve which provider-side property we're importing.
  let targetId = providerPropertyId ? String(providerPropertyId) : null;
  let choices = null;

  if (!targetId) {
    if (!otaPropertyId) {
      res.status(400);
      throw new Error("Enter your hotel ID, or pick your property from the list.");
    }
    let list = [];
    try {
      list = await svc.listProperties();
    } catch (err) {
      logger.warn(`[hotel] ${name} listProperties failed`, { err: err.message });
      res.status(502);
      throw new Error(
        "We couldn't reach your channel manager just now. Please try again in a moment.",
      );
    }
    const match = resolveByOtaId(list, otaPropertyId, name);
    if (match) {
      targetId = String(match.id);
    } else {
      // Honest failure. Neither provider exposes a Booking.com hotel-id field
      // we can look up, so rather than importing a hotel we merely suspect is
      // theirs, we hand back what we CAN see and let them pick. Returned as a
      // 200 with resolved:false — it's a normal branch of the flow, not an
      // error, and the error middleware would strip `choices` off a thrown one.
      choices = list.map((p) => ({
        providerPropertyId: String(p.id),
        name: p.title || p.name || p.propertyName || "Property",
        city: p.city || "",
        country: p.country || "",
        rooms: Array.isArray(p.roomTypes) ? p.roomTypes.length : undefined,
      }));
      return res.json({
        success: true,
        resolved: false,
        provider: name,
        choices,
        message: choices.length
          ? "We couldn't match that hotel ID to a property on your channel account — " +
            "pick your property below and we'll bring it across."
          : "We couldn't find any properties on your channel account yet. Once your OTA " +
            "listing is linked to the channel manager it'll show up here.",
      });
    }
  }

  // Don't let one workspace hijack another's connected hotel.
  // Per-provider id fields: a ternary would silently route any future provider
  // into the Beds24 field and corrupt the ownership check, so map explicitly and
  // fail loudly on a provider we don't have a field for.
  const ID_FIELDS = {
    channex: "channel.channexPropertyId",
    beds24: "channel.beds24PropertyId",
  };
  const idField = ID_FIELDS[name];
  if (!idField) {
    res.status(500);
    throw new Error(`No property-id field configured for provider "${name}".`);
  }
  const existing = await Property.findOne({
    [idField]: targetId,
    workspaceId: { $ne: req.workspace._id },
  });
  if (existing) {
    res.status(409);
    throw new Error("This property is already connected to another account.");
  }

  const { property, roomTypes } = await svc.importProperty(
    req.workspace._id,
    targetId,
  );

  // Best-effort webhook — a missed registration is covered by the poll job.
  try {
    await svc.registerWebhook(targetId);
  } catch (err) {
    logger.warn(`[hotel] ${name} webhook registration failed`, {
      err: err.message,
    });
  }

  // Give the caller the real state immediately, so the review screen can show
  // blockers (a room with no rate) the moment the import lands.
  let connection = null;
  try {
    const sync = await refreshConnectionState(property);
    const readiness = await evaluateReadiness(property);
    connection = connectionPayload(property, sync, readiness);
  } catch (err) {
    logger.warn("[hotel] post-import connection refresh failed", {
      err: err.message,
    });
  }

  res.json({
    success: true,
    resolved: true,
    provider: name,
    property,
    roomTypes,
    connection,
  });
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
    baseOccupancy: Number(b.baseOccupancy) || 2,
    extraGuestFee: Number(b.extraGuestFee) || 0,
    ...(b.breakfast ? { breakfast: b.breakfast } : {}),
    ...(b.cancellation ? { cancellation: b.cancellation } : {}),
    ...(b.bathroom ? { bathroom: b.bathroom } : {}),
    ...(b.smokingAllowed !== undefined
      ? { smokingAllowed: !!b.smokingAllowed }
      : {}),
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
    "baseOccupancy",
    "extraGuestFee",
    "breakfast",
    "cancellation",
    "bathroom",
    "smokingAllowed",
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
  // Free-text search over guest name, phone and booking code. Phone matching is
  // separator-tolerant because guestPhone is stored exactly as the guest typed
  // it ("+62 812 3456" must match a search for "628123456").
  const term = String(req.query.search || req.query.query || "").trim();
  if (term) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const digits = term.replace(/\D/g, "");
    const or = [
      { guestName: new RegExp(esc, "i") },
      { code: new RegExp(esc, "i") },
      { guestEmail: new RegExp(esc, "i") },
    ];
    if (digits.length >= 4) {
      // Allow any separators between the digits the caller typed.
      or.push({ guestPhone: new RegExp(digits.split("").join("[^0-9]*"), "i") });
    }
    q.$or = or;
  }
  // Resolve the booking(s) tied to a chat, so the inbox can show booking
  // context beside the conversation.
  if (req.query.contactId) q.contactId = req.query.contactId;
  if (req.query.conversationId) q.conversationId = req.query.conversationId;
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

// ─── Beds24 inbound webhook (public route) ──────────────────────────────────

// @POST /api/beds24/webhook?token=...
// Beds24 posts the booking itself as JSON in the body, so there's usually no
// follow-up API call. Two flavours arrive on this URL depending on which
// webhook the hotel enabled: the BOOKING webhook (a booking object) and the
// INVENTORY one ({roomId, propId, action:"SYNC_ROOM"}), which only says "this
// room changed" and carries no booking to ingest — we ack and ignore it.
const handleBeds24Webhook = asyncHandler(async (req, res) => {
  if (!beds24Service.verifyWebhookToken(req.query.token)) {
    logger.warn("[Beds24 webhook] bad token — dropping");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // ack fast, process async

  const payload = req.body || {};
  if (payload.action === "SYNC_ROOM") {
    logger.info(`[Beds24 webhook] inventory sync room=${payload.roomId}`);
    return;
  }
  try {
    await beds24Service.handleBookingEvent(payload);
  } catch (err) {
    logger.error("[Beds24 webhook] processing failed", { err: err.message });
  }
});

module.exports = {
  listProperties,
  createProperty,
  updateProperty,
  listChannexProperties,
  importChannexProperty,
  listBeds24Properties,
  importBeds24Property,
  getConnection,
  refreshConnection,
  importByConnection,
  listRoomTypes,
  createRoomType,
  updateRoomType,
  roomAvailability,
  checkRange,
  listBookings,
  createManualBooking,
  updateBookingStatus,
  handleChannexWebhook,
  handleBeds24Webhook,
};
