/**
 * upsellController — dashboard-side management of extras.
 *
 *   GET   /api/growth/upsells          → list offers (filter: status)
 *   POST  /api/growth/upsells          → offer an extra on a booking
 *   PATCH /api/growth/upsells/:id      → accept / decline an offer
 *   GET   /api/growth/upsell-catalog   → the property's catalog
 *   PUT   /api/growth/upsell-catalog   → replace the catalog (owner only)
 *
 * The bot-driven path calls services/hotel/upsellService directly.
 */
const asyncHandler = require("express-async-handler");
const Upsell = require("../models/Upsell");
const HotelBooking = require("../models/HotelBooking");
const Property = require("../models/Property");
const {
  DEFAULT_UPSELLS,
  offerUpsell,
  acceptUpsell,
  declineUpsell,
} = require("../services/hotel/upsellService");

const STATUSES = ["offered", "accepted", "declined", "cancelled"];

/** The workspace's property — explicit id, else its only/first active one. */
const resolveProperty = async (req) => {
  const q = { workspaceId: req.workspace._id };
  if (req.query.propertyId || req.body?.propertyId) {
    q._id = req.query.propertyId || req.body.propertyId;
  } else {
    q.active = true;
  }
  return Property.findOne(q).sort({ createdAt: 1 });
};

// @GET / — list offers, newest first.
const list = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const q = { workspaceId: req.workspace._id };
  if (status) {
    if (!STATUSES.includes(status)) {
      res.status(400);
      throw new Error(`status must be one of: ${STATUSES.join(", ")}`);
    }
    q.status = status;
  }
  const upsells = await Upsell.find(q)
    .sort({ createdAt: -1 })
    .limit(500)
    .populate("bookingId", "code guestName checkIn checkOut")
    .lean();
  res.json({ success: true, upsells });
});

// @POST / — offer an extra on a booking.
const offer = asyncHandler(async (req, res) => {
  const { bookingId, key, quantity } = req.body || {};
  if (!bookingId || !key) {
    res.status(400);
    throw new Error("bookingId and key are required");
  }

  const booking = await HotelBooking.findOne({
    _id: bookingId,
    workspaceId: req.workspace._id,
  });
  if (!booking) {
    res.status(404);
    throw new Error("Booking not found");
  }

  const result = await offerUpsell({
    workspace: req.workspace,
    booking,
    key,
    quantity,
  });
  if (!result.ok) {
    res.status(400);
    throw new Error(
      result.reason === "not_in_catalog"
        ? "That extra isn't in this property's catalog (or it's switched off)"
        : `Could not offer that extra (${result.reason})`,
    );
  }

  res.status(201).json({ success: true, upsell: result.upsell });
});

// @PATCH /:id — accept or decline an offer.
const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!["accepted", "declined"].includes(status)) {
    res.status(400);
    throw new Error("status must be 'accepted' or 'declined'");
  }

  const result =
    status === "accepted"
      ? await acceptUpsell({ workspace: req.workspace, upsellId: req.params.id })
      : await declineUpsell(req.params.id, req.workspace._id);

  if (!result.ok) {
    if (result.reason === "not_found") {
      res.status(404);
      throw new Error("Upsell not found");
    }
    res.status(400);
    throw new Error(`Could not update that extra (${result.reason})`);
  }

  res.json({ success: true, upsell: result.upsell });
});

// @GET /catalog — what this property offers.
const getCatalog = asyncHandler(async (req, res) => {
  const property = await resolveProperty(req);
  if (!property) {
    res.status(404);
    throw new Error("No property found — add a property first");
  }
  res.json({
    success: true,
    propertyId: property._id,
    currency: property.currency,
    upsells: property.upsells || [],
    defaults: DEFAULT_UPSELLS,
  });
});

// @PUT /catalog — replace the catalog wholesale (owner only).
const putCatalog = asyncHandler(async (req, res) => {
  const { upsells } = req.body || {};
  if (!Array.isArray(upsells)) {
    res.status(400);
    throw new Error("upsells must be an array");
  }

  const clean = [];
  for (const u of upsells.slice(0, 50)) {
    const key = String(u?.key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    if (!key) continue;
    clean.push({
      key,
      label: String(u.label || key).slice(0, 120),
      price: Math.max(0, Number(u.price) || 0),
      enabled: u.enabled !== false,
      description: String(u.description || "").slice(0, 500),
    });
  }
  if (!clean.length) {
    res.status(400);
    throw new Error("At least one extra with a valid key is required");
  }

  const property = await resolveProperty(req);
  if (!property) {
    res.status(404);
    throw new Error("No property found — add a property first");
  }

  property.upsells = clean;
  await property.save();
  res.json({ success: true, upsells: property.upsells });
});

module.exports = { list, offer, updateStatus, getCatalog, putCatalog };
