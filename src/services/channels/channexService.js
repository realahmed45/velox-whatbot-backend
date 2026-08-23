/**
 * channexService — OTA connectivity via Channex.io (Booking.com, Airbnb, …).
 *
 * Channex is our channel-manager API: hotels' listings are imported from it at
 * onboarding, availability is pushed to it after every bot booking, and OTA
 * reservations arrive back on its webhook.
 *
 * API: JSON:API-ish — resources under {data: [{id, attributes: {...}}]}.
 * Auth: `user-api-key` header.
 *
 * Env:
 *   CHANNEX_API_KEY        — user API key
 *   CHANNEX_BASE_URL       — default https://staging.channex.io/api/v1
 *                            (production: https://app.channex.io/api/v1)
 *   CHANNEX_WEBHOOK_TOKEN  — shared secret we put in our callback URL and
 *                            verify on every inbound webhook
 */
const axios = require("axios");
const logger = require("../../utils/logger");
const Property = require("../../models/Property");
const RoomType = require("../../models/RoomType");

const BASE = (
  process.env.CHANNEX_BASE_URL || "https://staging.channex.io/api/v1"
).replace(/\/$/, "");
const KEY = process.env.CHANNEX_API_KEY || "";
const WEBHOOK_TOKEN = process.env.CHANNEX_WEBHOOK_TOKEN || "";

const isConfigured = () => !!KEY;

const client = () =>
  axios.create({
    baseURL: BASE,
    headers: { "user-api-key": KEY, "Content-Type": "application/json" },
    timeout: 20000,
  });

/** Unwrap a JSON:API item → flat {id, ...attributes}. */
const flat = (item) =>
  item ? { id: item.id, ...(item.attributes || {}) } : null;
const flatList = (data) => (Array.isArray(data) ? data.map(flat) : []);

// ── Read APIs (import) ───────────────────────────────────────────────────────

async function listProperties() {
  const { data } = await client().get("/properties");
  return flatList(data?.data);
}

async function getProperty(channexPropertyId) {
  const { data } = await client().get(`/properties/${channexPropertyId}`);
  return flat(data?.data);
}

async function listRoomTypes(channexPropertyId) {
  const { data } = await client().get("/room_types", {
    params: { "filter[property_id]": channexPropertyId },
  });
  return flatList(data?.data);
}

async function listRatePlans(channexPropertyId) {
  const { data } = await client().get("/rate_plans", {
    params: { "filter[property_id]": channexPropertyId },
  });
  return flatList(data?.data);
}

async function listPhotos(channexPropertyId) {
  try {
    const { data } = await client().get("/photos", {
      params: { "filter[property_id]": channexPropertyId },
    });
    return flatList(data?.data);
  } catch (err) {
    logger.warn("[Channex] photos fetch failed", { err: err.message });
    return [];
  }
}

/** Which OTA channels are live for a property (informational). */
async function listConnectedChannels(channexPropertyId) {
  try {
    const { data } = await client().get("/channels", {
      params: { "filter[property_id]": channexPropertyId },
    });
    return flatList(data?.data).map(
      (c) => c.channel || c.channel_code || c.title || "unknown",
    );
  } catch {
    return [];
  }
}

async function getBooking(channexBookingId) {
  const { data } = await client().get(`/bookings/${channexBookingId}`);
  return flat(data?.data);
}

// ── Import: Channex property → our Property + RoomTypes ─────────────────────

/**
 * Import (or refresh) one Channex property into a workspace. Idempotent:
 * re-running updates the same docs (matched by channex ids).
 * @returns {Promise<{property, roomTypes}>}
 */
async function importProperty(workspaceId, channexPropertyId) {
  const [cp, roomTypes, ratePlans, photos] = await Promise.all([
    getProperty(channexPropertyId),
    listRoomTypes(channexPropertyId),
    listRatePlans(channexPropertyId),
    listPhotos(channexPropertyId),
  ]);
  if (!cp) throw new Error("Channex property not found");

  const connectedOtas = await listConnectedChannels(channexPropertyId);

  const propertyPhotos = photos
    .filter((p) => !p.room_type_id)
    .map((p, i) => ({
      url: p.url,
      caption: p.description || "",
      position: p.position ?? i,
    }));

  const property = await Property.findOneAndUpdate(
    { "channel.channexPropertyId": channexPropertyId },
    {
      $set: {
        workspaceId,
        name: cp.title || cp.name || "Imported property",
        description: cp.description || "",
        address: cp.address || "",
        city: cp.city || "",
        state: cp.state || "",
        country: cp.country || "",
        zipCode: cp.zip_code || "",
        latitude: cp.latitude ? Number(cp.latitude) : undefined,
        longitude: cp.longitude ? Number(cp.longitude) : undefined,
        timezone: cp.timezone || "Asia/Makassar",
        currency: cp.currency || "USD",
        email: cp.email || "",
        phone: cp.phone || "",
        ...(propertyPhotos.length ? { photos: propertyPhotos } : {}),
        "channel.provider": "channex",
        "channel.status": "connected",
        "channel.channexPropertyId": channexPropertyId,
        "channel.channexGroupId": cp.group_id || null,
        "channel.connectedOtas": connectedOtas,
        "channel.lastSyncAt": new Date(),
        "channel.lastError": null,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const savedRoomTypes = [];
  for (const rt of roomTypes) {
    const plan =
      ratePlans.find((rp) => rp.room_type_id === rt.id) || ratePlans[0] || {};
    const rtPhotos = photos
      .filter((p) => p.room_type_id === rt.id)
      .map((p, i) => ({
        url: p.url,
        caption: p.description || "",
        position: p.position ?? i,
      }));
    const doc = await RoomType.findOneAndUpdate(
      { channexRoomTypeId: rt.id },
      {
        $set: {
          workspaceId,
          propertyId: property._id,
          name: rt.title || rt.name || "Room",
          description: rt.description || "",
          unitsCount: rt.count_of_rooms || rt.rooms_count || 1,
          maxAdults: rt.occ_adults || 2,
          maxChildren: rt.occ_children || 0,
          maxOccupancy:
            (rt.occ_adults || 2) + (rt.occ_children || 0) ||
            rt.default_occupancy ||
            2,
          currency: plan.currency || cp.currency || "USD",
          channexRoomTypeId: rt.id,
          channexRatePlanId: plan.id || null,
          ...(rtPhotos.length ? { photos: rtPhotos } : {}),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    savedRoomTypes.push(doc);
  }

  logger.info(
    `[Channex] imported property ${channexPropertyId} → ws=${workspaceId} rooms=${savedRoomTypes.length}`,
  );
  return { property, roomTypes: savedRoomTypes };
}

// ── Availability push ────────────────────────────────────────────────────────

const dateStr = (d) => d.toISOString().slice(0, 10);

/**
 * Recompute our availability for [from, to) and push it to Channex so the
 * OTAs stop selling rooms the bot just booked.
 */
async function pushAvailabilityRange(property, roomType, from, to) {
  if (!isConfigured()) return;
  const { nightlyAvailability, DAY_MS } = require("../hotel/availability");
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  const nights = await nightlyAvailability(roomType, from, days);

  // Collapse consecutive nights with equal availability into ranges.
  const values = [];
  let cur = null;
  for (const n of nights) {
    if (cur && cur.availability === n.available) {
      cur.date_to = dateStr(n.date);
    } else {
      if (cur) values.push(cur);
      cur = {
        property_id: property.channel.channexPropertyId,
        room_type_id: roomType.channexRoomTypeId,
        date_from: dateStr(n.date),
        date_to: dateStr(n.date),
        availability: n.available,
      };
    }
  }
  if (cur) values.push(cur);
  if (!values.length) return;

  await client().post("/availability", { values });
  logger.info(
    `[Channex] availability pushed rt=${roomType.channexRoomTypeId} ranges=${values.length}`,
  );
}

/**
 * Push a nightly rate for [from, to) to the OTAs. Called when the owner
 * approves a pricing suggestion (or the engine runs in auto mode).
 * Channex wants one value row per rate plan + date range.
 */
async function pushRateRange(property, roomType, from, to, rate) {
  if (!isConfigured()) return;
  if (!roomType.channexRatePlanId) {
    logger.warn("[Channex] no rate plan mapped for room " + roomType._id);
    return;
  }
  const last = new Date(to.getTime() - 24 * 60 * 60 * 1000); // inclusive end
  const values = [
    {
      property_id: property.channel.channexPropertyId,
      rate_plan_id: roomType.channexRatePlanId,
      date_from: dateStr(from),
      date_to: dateStr(last),
      rate: Math.round(rate * 100), // Channex expects minor units
    },
  ];
  await client().post("/restrictions", { values });
  logger.info(
    "[Channex] rate pushed plan=" + roomType.channexRatePlanId + " rate=" + rate,
  );
}

// ── Webhook registration + inbound handling ─────────────────────────────────

function webhookCallbackUrl() {
  const base =
    process.env.API_PUBLIC_URL || "https://velox-whatbot-backend.onrender.com";
  return `${base}/api/channex/webhook?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
}

/** Register our webhook for a property (idempotent enough for v1). */
async function registerWebhook(channexPropertyId) {
  if (!isConfigured()) return null;
  const body = {
    webhook: {
      property_id: channexPropertyId,
      callback_url: webhookCallbackUrl(),
      event_mask: "*",
      is_active: true,
      send_data: true,
    },
  };
  const { data } = await client().post("/webhooks", body);
  return flat(data?.data);
}

const verifyWebhookToken = (token) =>
  !!WEBHOOK_TOKEN && token === WEBHOOK_TOKEN;

/** Map Channex/OTA channel naming → our booking source enum. */
function sourceFromOta(otaName = "") {
  const s = String(otaName).toLowerCase().replace(/[\s.]/g, "_");
  if (s.includes("booking")) return "booking_com";
  if (s.includes("airbnb")) return "airbnb";
  return "other_ota";
}

/**
 * Handle an inbound booking event. Payload shapes vary by event type; we
 * accept either an embedded booking payload or just an id we fetch.
 */
async function handleBookingEvent(payload) {
  const raw = payload?.payload || payload?.data || payload || {};
  const bookingId =
    raw.booking_id || raw.id || payload?.booking_id || payload?.id;

  let b = raw.attributes ? flat(raw) : raw;
  const looksComplete = b && (b.arrival_date || b.checkin_date || b.rooms);
  if (!looksComplete && bookingId) {
    try {
      b = await getBooking(bookingId);
    } catch (err) {
      logger.error("[Channex] booking fetch failed", {
        bookingId,
        err: err.message,
      });
      return { ok: false, reason: "fetch_failed" };
    }
  }
  if (!b) return { ok: false, reason: "empty_payload" };

  const channexPropertyId = b.property_id || raw.property_id;
  const property = await Property.findOne({
    "channel.channexPropertyId": channexPropertyId,
  });
  if (!property) {
    logger.warn("[Channex] webhook for unknown property", { channexPropertyId });
    return { ok: false, reason: "unknown_property" };
  }

  const status =
    String(b.status || "").toLowerCase() === "cancelled" ||
    String(payload?.event || "").includes("cancel")
      ? "cancelled"
      : "confirmed";

  const customer = b.customer || {};
  const guestName =
    customer.name ||
    [customer.first_name, customer.surname || customer.last_name]
      .filter(Boolean)
      .join(" ");

  const rooms = Array.isArray(b.rooms) && b.rooms.length ? b.rooms : [b];
  const { ingestOtaBooking } = require("../hotel/bookingService");
  const results = [];
  for (const [i, room] of rooms.entries()) {
    const roomType =
      (room.room_type_id &&
        (await RoomType.findOne({ channexRoomTypeId: room.room_type_id }))) ||
      (await RoomType.findOne({ propertyId: property._id }));
    if (!roomType) continue;
    const checkIn = room.checkin_date || b.arrival_date || b.checkin_date;
    const checkOut = room.checkout_date || b.departure_date || b.checkout_date;
    const res = await ingestOtaBooking({
      property,
      roomType,
      otaReservationId: `${b.unique_id || b.ota_reservation_code || bookingId}${rooms.length > 1 ? `#${i}` : ""}`,
      channexBookingId: String(bookingId || b.id || ""),
      source: sourceFromOta(b.ota_name || b.channel_name),
      status,
      checkIn,
      checkOut,
      guestName,
      guestPhone: customer.phone || "",
      guestEmail: customer.mail || customer.email || "",
      adults: Number(room.occupancy?.adults ?? b.occupancy?.adults ?? 2),
      children: Number(room.occupancy?.children ?? b.occupancy?.children ?? 0),
      totalAmount: Number(room.amount || b.amount || 0),
      currency: b.currency || property.currency,
      raw: b,
    });
    results.push(res);
  }
  return { ok: true, results };
}

/** Review.source enum is narrower than the booking one — "other_ota" → "other". */
function reviewSourceFromOta(otaName = "") {
  const s = sourceFromOta(otaName);
  return s === "other_ota" ? "other" : s;
}

/**
 * Handle an inbound REVIEW event. Channex has shipped review payloads in a few
 * shapes over time (flat, JSON:API `attributes`, nested under `review`), so we
 * probe the usual field names and log anything we can't read rather than
 * guessing. Maps onto reputation/reviewService.ingestReview().
 */
async function handleReviewEvent(payload) {
  const outer = payload?.payload || payload?.data || payload || {};
  const r = outer.attributes ? flat(outer) : outer.review || outer;
  if (!r || typeof r !== "object") return { ok: false, reason: "empty_payload" };

  const channexPropertyId =
    r.property_id || outer.property_id || payload?.property_id;
  const property = await Property.findOne({
    "channel.channexPropertyId": channexPropertyId,
  });
  if (!property) {
    logger.warn("[Channex] review for unknown property", { channexPropertyId });
    return { ok: false, reason: "unknown_property" };
  }

  // Channex OTA reviews are usually /10 (Booking.com) or /5 (Airbnb). Trust an
  // explicit scale when present, else infer from the value.
  const rating = Number(
    r.rating ?? r.score ?? r.overall_rating ?? r.average_score,
  );
  if (!Number.isFinite(rating)) {
    logger.warn("[Channex] review payload without a readable rating", {
      keys: Object.keys(r).slice(0, 20),
    });
    return { ok: false, reason: "no_rating" };
  }
  const scale = Number(r.rating_scale || r.scale) || (rating > 5 ? 10 : 5);

  const externalId =
    r.review_id || r.id || outer.review_id || outer.id || null;

  // Best-effort link back to the stay this review is about.
  let bookingId;
  const otaReservationId =
    r.booking_unique_id || r.unique_id || r.ota_reservation_code || null;
  if (otaReservationId) {
    const HotelBooking = require("../../models/HotelBooking");
    const booking = await HotelBooking.findOne({
      otaReservationId: String(otaReservationId),
    })
      .select("_id")
      .lean();
    if (booking) bookingId = booking._id;
  }

  const { ingestReview } = require("../reputation/reviewService");
  return ingestReview({
    workspaceId: property.workspaceId,
    propertyId: property._id,
    // sourceFromOta() speaks the BOOKING enum; Review has no "other_ota".
    source: reviewSourceFromOta(r.ota_name || r.channel_name || outer.ota_name),
    externalId: externalId ? String(externalId) : null,
    guestName:
      r.guest_name || r.author || r.customer?.name || r.reviewer_name || "",
    rating,
    ratingScale: scale,
    title: r.title || r.headline || "",
    text: r.text || r.comment || r.content || r.public_review || "",
    language: r.language || r.locale || "",
    reviewedAt: r.created_at || r.review_date || r.submitted_at || undefined,
    bookingId,
  });
}

module.exports = {
  isConfigured,
  listProperties,
  getProperty,
  listRoomTypes,
  listRatePlans,
  listPhotos,
  importProperty,
  pushAvailabilityRange,
  pushRateRange,
  registerWebhook,
  verifyWebhookToken,
  handleBookingEvent,
  handleReviewEvent,
  sourceFromOta,
};
