/**
 * publicBookingController — the hotel's own booking page at /book/<slug>.
 *
 * No auth, no OTA cut. Three endpoints: what the hotel is, what's free, book it.
 * Everything here is public, so it exposes only guest-facing fields — never
 * workspace ids, channel config, commission, or anything about other bookings.
 */
const asyncHandler = require("express-async-handler");
const Property = require("../models/Property");
const RoomType = require("../models/RoomType");
const Workspace = require("../models/Workspace");
const { createBooking } = require("../services/hotel/bookingService");
const { getAvailableUnits, toDay } = require("../services/hotel/availability");
const logger = require("../utils/logger");

const MAX_NIGHTS = 30;
const MAX_ADULTS = 20;
const MAX_CHILDREN = 20;

/** "Villa Sunset Bali" → "villa-sunset-bali" */
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(new RegExp("[\u0300-\u036f]", "g"), "") // strip accents
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function randomSuffix() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(0, 4);
}

/**
 * Give a property a public slug if it doesn't have one, retrying with a short
 * random suffix on collision (the slug is globally unique in the DB).
 * Returns the slug, or null if we couldn't make one.
 */
async function ensureSlug(property) {
  if (property.directBooking?.slug) return property.directBooking.slug;

  const base = slugify(property.name) || "stay";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    const taken = await Property.exists({ "directBooking.slug": candidate });
    if (taken) continue;
    try {
      property.directBooking = property.directBooking || {};
      property.directBooking.slug = candidate;
      if (property.directBooking.enabled === undefined) {
        property.directBooking.enabled = true;
      }
      await property.save();
      return candidate;
    } catch (err) {
      // Lost a race on the unique index — try another suffix.
      if (err.code !== 11000) throw err;
      property.directBooking.slug = null;
    }
  }
  logger.warn(`[book] could not generate slug for property=${property._id}`);
  return null;
}

/** Find a live, publicly-bookable property by slug, or 404. */
async function loadPublicProperty(req, res) {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const property = await Property.findOne({
    "directBooking.slug": slug,
    active: true,
  });
  if (!property || property.directBooking?.enabled === false) {
    res.status(404);
    throw new Error("This booking page isn't available");
  }
  return property;
}

function publicRoom(rt) {
  return {
    id: rt._id,
    name: rt.name,
    description: rt.description || "",
    photos: (rt.photos || []).map((p) => ({
      url: p.url,
      caption: p.caption || "",
    })),
    maxOccupancy: rt.maxOccupancy || 2,
    maxAdults: rt.maxAdults || 2,
    maxChildren: rt.maxChildren || 0,
    bedConfig: rt.bedConfig || "",
    amenities: rt.amenities || [],
    baseRate: rt.baseRate || 0,
    currency: rt.currency || "USD",
  };
}

// ─── Public endpoints ───────────────────────────────────────────────────────

// @GET /api/book/:slug
const getPublicProperty = asyncHandler(async (req, res) => {
  const property = await loadPublicProperty(req, res);
  const roomTypes = await RoomType.find({
    propertyId: property._id,
    active: true,
  }).sort({ baseRate: 1 });

  res.json({
    success: true,
    property: {
      name: property.name,
      description: property.description || "",
      propertyType: property.propertyType,
      photos: (property.photos || []).map((p) => ({
        url: p.url,
        caption: p.caption || "",
      })),
      address: property.address || "",
      city: property.city || "",
      country: property.country || "",
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
      policies: property.policies || "",
      currency: property.currency || "USD",
      amenities: property.amenities || [],
      starRating: property.starRating || 0,
    },
    rooms: roomTypes.map(publicRoom),
  });
});

// @GET /api/book/:slug/availability?checkIn=&checkOut=&adults=
const getPublicAvailability = asyncHandler(async (req, res) => {
  const property = await loadPublicProperty(req, res);

  const from = toDay(req.query.checkIn);
  const to = toDay(req.query.checkOut);
  if (!from || !to) {
    res.status(400);
    throw new Error("Please pick a check-in and check-out date");
  }
  if (to <= from) {
    res.status(400);
    throw new Error("Check-out must be after check-in");
  }
  const nights = Math.round((to - from) / (24 * 60 * 60 * 1000));
  if (nights > MAX_NIGHTS) {
    res.status(400);
    throw new Error(`Stays are limited to ${MAX_NIGHTS} nights`);
  }
  const adults = Math.max(1, parseInt(req.query.adults, 10) || 1);

  const roomTypes = await RoomType.find({
    propertyId: property._id,
    active: true,
  }).sort({ baseRate: 1 });

  const rooms = [];
  for (const rt of roomTypes) {
    const check = await getAvailableUnits(rt, from, to);
    const fits = adults <= (rt.maxOccupancy || 2);
    const available = check.ok ? check.available : 0;
    const rate = rt.baseRate || 0;
    rooms.push({
      ...publicRoom(rt),
      available: fits ? available : 0,
      nights,
      total: Math.round(rate * nights * 100) / 100,
      bookable: Boolean(fits && available > 0),
      reason: !fits ? "too_many_guests" : available > 0 ? null : "sold_out",
    });
  }

  res.json({
    success: true,
    checkIn: from,
    checkOut: to,
    nights,
    currency: property.currency || "USD",
    rooms,
  });
});

// @POST /api/book/:slug/book
const createPublicBooking = asyncHandler(async (req, res) => {
  const property = await loadPublicProperty(req, res);
  const b = req.body || {};

  const guestName = String(b.guestName || "").trim();
  const guestPhone = String(b.guestPhone || "").trim();
  const guestEmail = String(b.guestEmail || "").trim();
  if (!b.roomTypeId || !guestName) {
    res.status(400);
    throw new Error("Please give us a room and your name");
  }
  if (!guestPhone && !guestEmail) {
    res.status(400);
    throw new Error("Please give us a phone number or an email");
  }

  const from = toDay(b.checkIn);
  const to = toDay(b.checkOut);
  if (!from || !to) {
    res.status(400);
    throw new Error("Please pick a check-in and check-out date");
  }
  if (to <= from) {
    res.status(400);
    throw new Error("Check-out must be after check-in");
  }
  const nights = Math.round((to - from) / (24 * 60 * 60 * 1000));
  if (nights > MAX_NIGHTS) {
    res.status(400);
    throw new Error(`Stays are limited to ${MAX_NIGHTS} nights`);
  }

  const adults = Math.max(1, parseInt(b.adults, 10) || 1);
  const children = Math.max(0, parseInt(b.children, 10) || 0);
  if (adults > MAX_ADULTS || children > MAX_CHILDREN) {
    res.status(400);
    throw new Error("That's more guests than we can book online");
  }

  // The room must belong to THIS property — never trust a posted id.
  const roomType = await RoomType.findOne({
    _id: b.roomTypeId,
    propertyId: property._id,
    active: true,
  });
  if (!roomType) {
    res.status(404);
    throw new Error("That room isn't available");
  }
  if (adults + children > (roomType.maxOccupancy || 2)) {
    res.status(400);
    throw new Error("That room doesn't fit that many guests");
  }

  const workspace = await Workspace.findById(property.workspaceId);
  if (!workspace) {
    res.status(404);
    throw new Error("This booking page isn't available");
  }

  const result = await createBooking({
    workspace,
    propertyId: property._id,
    roomTypeId: roomType._id,
    checkIn: from,
    checkOut: to,
    guestName,
    guestPhone,
    guestEmail,
    adults,
    children,
    unitsBooked: 1,
    source: "direct",
    specialRequests: String(b.specialRequests || "").slice(0, 1000),
  });

  if (!result.ok) {
    const messages = {
      no_availability: "Sorry — that room just sold out for those dates.",
      past_date: "Please pick a check-in date in the future.",
      checkout_before_checkin: "Check-out must be after check-in.",
      invalid_dates: "Those dates don't look right.",
      room_type_not_found: "That room isn't available.",
      property_not_found: "This booking page isn't available.",
    };
    res.status(400);
    throw new Error(
      messages[result.reason] || "We couldn't complete that booking.",
    );
  }

  const booking = result.booking;
  logger.info(
    `[book] direct booking ${booking.code} slug=${property.directBooking.slug}`,
  );
  res.status(201).json({
    success: true,
    ok: true,
    code: booking.code,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights: booking.nights,
    total: booking.totalAmount,
    currency: booking.currency,
    roomName: roomType.name,
    message: result.confirmationText,
  });
});

module.exports = {
  getPublicProperty,
  getPublicAvailability,
  createPublicBooking,
  ensureSlug,
  slugify,
};
