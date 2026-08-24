/**
 * beds24Service — OTA connectivity via Beds24 (Booking.com, Airbnb, …).
 *
 * The second channel provider alongside Channex. Beds24 is a channel manager +
 * PMS with a free trial that includes LIVE OTA connections, which is what makes
 * it useful: a real hotel can be wired up end-to-end without a sales call.
 * Channex stays the production provider; a property picks one via
 * `channel.provider` and services/channels/index.js routes to the right module.
 *
 * API: flat JSON — reads return {success, data: [...]}, writes take a BARE
 * ARRAY of items and return one result object per item, in request order.
 * Auth: short-lived access token in the `token` header, minted from a long-life
 * refresh token. See "Token flow" below.
 *
 * Docs (verified):
 *   https://wiki.beds24.com/index.php/Category:API_V2   — the reference
 *   https://beds24.com/api/v2/                          — interactive Swagger
 *
 * Endpoints used:
 *   GET  /authentication/setup            invite code → refresh token
 *   GET  /authentication/token            refresh token → access token
 *   GET  /properties                      properties + their roomTypes
 *   GET  /inventory/rooms/calendar        per-day availability/prices (read)
 *   POST /inventory/rooms/calendar        per-day availability/prices (write)
 *   GET  /bookings                        reservations, filterable by modifiedFrom
 *
 * Token flow:
 *   1. The hotel generates an invite code in the Beds24 control panel under
 *      (SETTINGS) MARKETPLACE > API. Codes expire after 24 hours.
 *   2. We exchange it once via GET /authentication/setup → a refresh token,
 *      which is what goes in BEDS24_REFRESH_TOKEN. Refresh tokens live forever
 *      as long as they're used at least every 30 days.
 *   3. Access tokens minted from it expire after 24h, so we cache one in memory
 *      and re-mint on expiry (and once on a 401, in case the cache went stale).
 *
 * Env:
 *   BEDS24_API_BASE        — default https://api.beds24.com/v2
 *   BEDS24_REFRESH_TOKEN   — long-life refresh token (the one that matters)
 *   BEDS24_INVITE_CODE     — optional; only for the one-off first-time exchange
 *   BEDS24_WEBHOOK_TOKEN   — shared secret we put in our callback URL and
 *                            verify on every inbound webhook
 */
const axios = require("axios");
const logger = require("../../utils/logger");
const Property = require("../../models/Property");
const RoomType = require("../../models/RoomType");

const BASE = (process.env.BEDS24_API_BASE || "https://api.beds24.com/v2").replace(
  /\/$/,
  "",
);
const REFRESH_TOKEN = process.env.BEDS24_REFRESH_TOKEN || "";
const INVITE_CODE = process.env.BEDS24_INVITE_CODE || "";
const WEBHOOK_TOKEN = process.env.BEDS24_WEBHOOK_TOKEN || "";

// Either credential can bootstrap us: a refresh token works immediately, an
// invite code is exchanged for one on first use.
const isConfigured = () => !!(REFRESH_TOKEN || INVITE_CODE);

// ── Token cache ──────────────────────────────────────────────────────────────

// Access tokens last 24h. Minting one costs API credits (the account budget is
// 100 credits per rolling 5 minutes by default), so we hold onto it and refresh
// a minute early rather than per request.
const EXPIRY_SKEW_MS = 60 * 1000;
let cached = { token: "", expiresAt: 0 };
// The refresh token can also arrive at runtime from an invite-code exchange,
// so it lives in a variable rather than being pinned to the env constant.
let refreshToken = REFRESH_TOKEN;
let inFlight = null; // de-dupe concurrent mints

const raw = () =>
  axios.create({ baseURL: BASE, timeout: 20000, headers: { Accept: "application/json" } });

/**
 * Exchange the invite code for a refresh token. One-off: the code is single-use
 * and expires after 24h, so we log the result loudly — the operator is meant to
 * copy the refresh token into BEDS24_REFRESH_TOKEN and drop the invite code.
 */
async function setupFromInviteCode(code = INVITE_CODE) {
  if (!code) throw new Error("BEDS24_INVITE_CODE is not set");
  const { data } = await raw().get("/authentication/setup", {
    headers: { code, deviceName: "Botlify" },
  });
  if (!data?.refreshToken) throw new Error("Beds24 setup returned no refreshToken");
  refreshToken = data.refreshToken;
  if (data.token) {
    cached = {
      token: data.token,
      expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000 - EXPIRY_SKEW_MS,
    };
  }
  logger.warn(
    "[Beds24] invite code exchanged for a refresh token. Save it as " +
      "BEDS24_REFRESH_TOKEN — invite codes are single-use and expire in 24h.",
  );
  return { refreshToken: data.refreshToken, token: data.token };
}

/** A valid access token, minted (or re-minted) as needed. */
async function accessToken({ force = false } = {}) {
  if (!force && cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    if (!refreshToken) await setupFromInviteCode();
    if (cached.token && Date.now() < cached.expiresAt && !force) return cached.token;
    const { data } = await raw().get("/authentication/token", {
      headers: { refreshToken },
    });
    if (!data?.token) throw new Error("Beds24 returned no access token");
    cached = {
      token: data.token,
      expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000 - EXPIRY_SKEW_MS,
    };
    return cached.token;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Authenticated request. Retries ONCE on a 401 with a freshly minted token:
 * tokens can be revoked or expire early on the Beds24 side, and the whole
 * failure is invisible otherwise (a hotel whose sync quietly stopped).
 */
async function call(method, path, { params, data } = {}) {
  if (!isConfigured()) throw new Error("Beds24 is not configured");
  const send = async (token) =>
    raw().request({
      method,
      url: path,
      params,
      data,
      headers: { token, "Content-Type": "application/json" },
    });

  try {
    const res = await send(await accessToken());
    return res.data;
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    const res = await send(await accessToken({ force: true }));
    return res.data;
  }
}

/**
 * Beds24 writes answer with one result per submitted item and report failure in
 * the body, not the HTTP status — a 200 with `success:false` is a failed push.
 * Surface that as an error so callers log it instead of believing it worked.
 */
function assertWriteOk(results, what) {
  const list = Array.isArray(results) ? results : [results];
  const failed = list.filter((r) => r && r.success === false);
  if (!failed.length) return list;
  const why = failed
    .flatMap((r) => (r.errors || []).map((e) => e.message || String(e)))
    .filter(Boolean)
    .join("; ");
  throw new Error(`Beds24 ${what} rejected: ${why || "unknown error"}`);
}

// ── Read APIs (import) ───────────────────────────────────────────────────────

/**
 * All properties the token can see, each with its rooms.
 * GET /properties?includeAllRooms=true
 */
async function listProperties() {
  const data = await call("get", "/properties", {
    params: { includeAllRooms: true },
  });
  return Array.isArray(data?.data) ? data.data : [];
}

async function getProperty(beds24PropertyId) {
  const data = await call("get", "/properties", {
    params: {
      id: [beds24PropertyId],
      includeAllRooms: true,
      includeTexts: true,
      includePriceRules: true,
    },
  });
  return (Array.isArray(data?.data) ? data.data : [])[0] || null;
}

/**
 * Room types of a property. Beds24 nests them inside the property rather than
 * exposing a /rooms collection, so this is a projection, not a second call.
 */
async function listRoomTypes(beds24PropertyId) {
  const p = await getProperty(beds24PropertyId);
  return p?.roomTypes || [];
}

/**
 * Beds24 has no rate-plan resource of the Channex kind. The closest equivalent
 * is a room's price rules (Prices → Daily Price Rules), which map onto the
 * price1..price16 slots of the calendar. Returned for parity/inspection.
 */
async function listRatePlans(beds24PropertyId) {
  const rooms = await listRoomTypes(beds24PropertyId);
  return rooms.flatMap((r) =>
    (r.priceRules || []).map((pr) => ({ ...pr, roomId: r.id })),
  );
}

/**
 * Photos. API V2 does not expose images yet ("Can I use API V2 to send pictures
 * or webhooks? Currently no" — wiki FAQ), so any URLs we get are whatever the
 * property/room payload happens to carry. Never throws: a missing photo must
 * not fail an import.
 */
function listPhotos(propertyOrRoom) {
  const src = propertyOrRoom || {};
  const urls = [src.pictures, src.images, src.photos].find(Array.isArray) || [];
  return urls
    .map((p, i) =>
      typeof p === "string"
        ? { url: p, caption: "", position: i }
        : { url: p?.url || p?.src || "", caption: p?.caption || "", position: i },
    )
    .filter((p) => p.url);
}

/** Which OTA channels are live for a property (informational). */
function connectedOtasFrom(bp) {
  // Beds24 reports channel state per room as a map of channel → settings.
  // We only want the names, deduped, in our own vocabulary.
  const names = new Set();
  for (const room of bp?.roomTypes || []) {
    const ch = room.channels || room.channelSettings || {};
    for (const [key, val] of Object.entries(ch)) {
      const on = val === true || val?.enabled === true || val?.connected === true;
      if (on) names.add(sourceFromOta(key));
    }
  }
  return [...names];
}

async function getBooking(beds24BookingId) {
  const data = await call("get", "/bookings", {
    params: { id: [beds24BookingId], includeInfoItems: true },
  });
  return (Array.isArray(data?.data) ? data.data : [])[0] || null;
}

// ── Import: Beds24 property → our Property + RoomTypes ──────────────────────

/**
 * Import (or refresh) one Beds24 property into a workspace. Idempotent:
 * re-running updates the same docs (matched by beds24 ids).
 * @returns {Promise<{property, roomTypes}>}
 */
async function importProperty(workspaceId, beds24PropertyId) {
  const id = String(beds24PropertyId);
  const bp = await getProperty(id);
  if (!bp) throw new Error("Beds24 property not found");

  const propertyPhotos = listPhotos(bp);
  const connectedOtas = connectedOtasFrom(bp);

  const property = await Property.findOneAndUpdate(
    { "channel.beds24PropertyId": id },
    {
      $set: {
        workspaceId,
        name: bp.name || bp.propertyName || "Imported property",
        description: bp.description || bp.texts?.propertyDescription || "",
        address: bp.address || "",
        city: bp.city || "",
        state: bp.state || "",
        country: bp.country || "",
        zipCode: bp.postcode || bp.zip || "",
        latitude: bp.latitude ? Number(bp.latitude) : undefined,
        longitude: bp.longitude ? Number(bp.longitude) : undefined,
        // Beds24 stores an IANA zone on the property; keep our Bali default
        // rather than inventing one when it's absent.
        timezone: bp.timeZone || bp.timezone || "Asia/Makassar",
        currency: bp.currency || "USD",
        email: bp.email || "",
        phone: bp.phone || bp.mobile || "",
        ...(propertyPhotos.length ? { photos: propertyPhotos } : {}),
        "channel.provider": "beds24",
        "channel.status": "connected",
        "channel.beds24PropertyId": id,
        "channel.connectedOtas": connectedOtas,
        "channel.lastSyncAt": new Date(),
        "channel.lastError": null,
        // Enter the connection state machine. `imported` (not `live`) even
        // when channels came back connected — connectionService decides that
        // from the provider on its next pass, and it is the only thing allowed
        // to say a channel is live. See services/hotel/connectionService.js.
        "channel.sync.state": "imported",
        "channel.sync.lastCheckedAt": new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const savedRoomTypes = [];
  for (const rt of bp.roomTypes || []) {
    const rtPhotos = listPhotos(rt);
    const adults = Number(rt.maxAdult ?? rt.maxPeople ?? 2) || 2;
    const children = Number(rt.maxChildren ?? rt.maxChild ?? 0) || 0;
    const doc = await RoomType.findOneAndUpdate(
      { beds24RoomId: String(rt.id) },
      {
        $set: {
          workspaceId,
          propertyId: property._id,
          name: rt.name || rt.roomName || "Room",
          description: rt.description || rt.texts?.displayName || "",
          unitsCount: Number(rt.qty ?? rt.numRooms ?? 1) || 1,
          maxAdults: adults,
          maxChildren: children,
          maxOccupancy: Number(rt.maxPeople ?? adults + children) || adults,
          currency: bp.currency || "USD",
          beds24RoomId: String(rt.id),
          ...(rtPhotos.length ? { photos: rtPhotos } : {}),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    savedRoomTypes.push(doc);
  }

  logger.info(
    `[Beds24] imported property ${id} → ws=${workspaceId} rooms=${savedRoomTypes.length}`,
  );
  return { property, roomTypes: savedRoomTypes };
}

// ── Availability push ────────────────────────────────────────────────────────

const dateStr = (d) => d.toISOString().slice(0, 10);

/**
 * Recompute our availability for [from, to) and push it to Beds24 so the OTAs
 * stop selling rooms the bot just booked.
 *
 * POST /inventory/rooms/calendar takes a bare array of
 * {roomId, calendar:[{from, to, numAvail}]} — `to` is INCLUSIVE, unlike our
 * half-open ranges, so the last night is `to - 1 day`.
 */
async function pushAvailabilityRange(property, roomType, from, to) {
  if (!isConfigured()) return;
  if (!roomType.beds24RoomId) {
    logger.warn("[Beds24] no room mapped for room " + roomType._id);
    return;
  }
  const { nightlyAvailability, DAY_MS } = require("../hotel/availability");
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  const nights = await nightlyAvailability(roomType, from, days);

  // Collapse consecutive nights with equal availability into ranges.
  const calendar = [];
  let cur = null;
  for (const n of nights) {
    if (cur && cur.numAvail === n.available) {
      cur.to = dateStr(n.date);
    } else {
      if (cur) calendar.push(cur);
      cur = {
        from: dateStr(n.date),
        to: dateStr(n.date),
        numAvail: n.available,
      };
    }
  }
  if (cur) calendar.push(cur);
  if (!calendar.length) return;

  const res = await call("post", "/inventory/rooms/calendar", {
    data: [{ roomId: Number(roomType.beds24RoomId), calendar }],
  });
  assertWriteOk(res, "availability push");
  logger.info(
    `[Beds24] availability pushed room=${roomType.beds24RoomId} ranges=${calendar.length}`,
  );
}

/**
 * Push a nightly rate for [from, to) to the OTAs. Called when the owner
 * approves a pricing suggestion (or the engine runs in auto mode).
 *
 * Beds24 has no rate-plan objects: per-date prices live in the same calendar as
 * availability, in the price1..price16 slots. price1 is the room's primary
 * daily price, which is what the channels sell on — that's the one we set.
 * Rates go in MAJOR units (unlike Channex, which wants cents).
 */
async function pushRateRange(property, roomType, from, to, rate) {
  if (!isConfigured()) return;
  if (!roomType.beds24RoomId) {
    logger.warn("[Beds24] no room mapped for room " + roomType._id);
    return;
  }
  const last = new Date(to.getTime() - 24 * 60 * 60 * 1000); // inclusive end
  const res = await call("post", "/inventory/rooms/calendar", {
    data: [
      {
        roomId: Number(roomType.beds24RoomId),
        calendar: [{ from: dateStr(from), to: dateStr(last), price1: Number(rate) }],
      },
    ],
  });
  assertWriteOk(res, "rate push");
  logger.info(
    "[Beds24] rate pushed room=" + roomType.beds24RoomId + " rate=" + rate,
  );
}

// ── Webhook registration + inbound handling ─────────────────────────────────

function webhookCallbackUrl() {
  const base =
    process.env.API_PUBLIC_URL || "https://velox-whatbot-backend.onrender.com";
  return `${base}/api/beds24/webhook?token=${encodeURIComponent(WEBHOOK_TOKEN)}`;
}

/**
 * Beds24 booking webhooks are configured in the control panel per property
 * (Settings > Properties > Access > Booking webhooks) and CANNOT be registered
 * through API V2 — the wiki FAQ says webhook management is "coming soon".
 * So this doesn't call anything; it returns the URL the operator must paste in,
 * and logs it, so the import flow can still tell them what to do.
 */
async function registerWebhook(beds24PropertyId) {
  if (!isConfigured()) return null;
  const url = webhookCallbackUrl();
  logger.info(
    `[Beds24] property ${beds24PropertyId}: paste this into Settings > Properties > ` +
      `Access > Booking webhooks — ${url} (until then, the poll job covers it)`,
  );
  return { manual: true, callbackUrl: url };
}

const verifyWebhookToken = (token) =>
  !!WEBHOOK_TOKEN && token === WEBHOOK_TOKEN;

/** Map Beds24/OTA referrer naming → our booking source enum. */
function sourceFromOta(otaName = "") {
  const s = String(otaName).toLowerCase().replace(/[\s.]/g, "_");
  if (s.includes("booking")) return "booking_com";
  if (s.includes("airbnb")) return "airbnb";
  if (s.includes("agoda")) return "agoda";
  if (s.includes("expedia")) return "expedia";
  if (s.includes("vrbo") || s.includes("homeaway")) return "vrbo";
  if (s.includes("traveloka")) return "traveloka";
  if (s.includes("tiket")) return "tiket";
  if (s.includes("trip") || s.includes("ctrip")) return "trip_com";
  if (s.includes("hostelworld")) return "hostelworld";
  if (s.includes("google")) return "google_hotel";
  // Any other Beds24 channel still syncs — it just lands under a generic
  // label rather than being unsupported.
  return "other_ota";
}

/** Beds24 booking statuses → our two-state view of a stay. */
function statusFrom(b) {
  const s = String(b?.status || "").toLowerCase();
  // "black" is Beds24's blocked-off/owner-block state; treat it like a
  // cancellation for our purposes — the room simply isn't sellable to us.
  if (s === "cancelled" || s === "black") return "cancelled";
  return "confirmed";
}

/**
 * Ingest one Beds24 booking object into our bookings. Shared by the webhook and
 * the poll job so both paths behave identically (and both stay idempotent —
 * ingestOtaBooking keys on otaReservationId).
 */
async function ingestBooking(b) {
  if (!b) return { ok: false, reason: "empty_payload" };

  const beds24PropertyId = String(b.propertyId ?? b.propId ?? "");
  const property = await Property.findOne({
    "channel.beds24PropertyId": beds24PropertyId,
  });
  if (!property) {
    logger.warn("[Beds24] booking for unknown property", { beds24PropertyId });
    return { ok: false, reason: "unknown_property" };
  }

  const roomType =
    (b.roomId && (await RoomType.findOne({ beds24RoomId: String(b.roomId) }))) ||
    (await RoomType.findOne({ propertyId: property._id }));
  if (!roomType) return { ok: false, reason: "unknown_room" };

  const { ingestOtaBooking } = require("../hotel/bookingService");
  return ingestOtaBooking({
    property,
    roomType,
    // Beds24's own booking id is the stable key across modifications; the OTA's
    // own reference (apiReference/masterId) isn't always present.
    otaReservationId: `beds24:${b.id ?? b.bookingId}`,
    source: sourceFromOta(b.referer || b.channel || b.apiSource),
    status: statusFrom(b),
    checkIn: b.arrival,
    checkOut: b.departure,
    guestName: [b.firstName, b.lastName].filter(Boolean).join(" ") || b.guestName || "",
    guestPhone: b.phone || b.mobile || "",
    guestEmail: b.email || "",
    adults: Number(b.numAdult ?? 2),
    children: Number(b.numChild ?? 0),
    totalAmount: Number(b.price ?? 0),
    currency: property.currency,
    raw: b,
  });
}

/**
 * Handle an inbound booking webhook. Beds24 posts the booking itself as JSON in
 * the body — usually a single object, sometimes wrapped in {booking} or a list —
 * so in most cases no follow-up API call is needed. When the body carries only
 * an id we fetch the booking.
 */
async function handleBookingEvent(payload) {
  const outer = payload?.booking || payload?.data || payload || {};
  const items = Array.isArray(outer) ? outer : [outer];

  const results = [];
  for (const item of items) {
    let b = item;
    // A body with an id but no dates is a notification, not the booking.
    if (b && !b.arrival && (b.id || b.bookingId)) {
      try {
        b = await getBooking(b.id ?? b.bookingId);
      } catch (err) {
        logger.error("[Beds24] booking fetch failed", {
          bookingId: item.id ?? item.bookingId,
          err: err.message,
        });
        results.push({ ok: false, reason: "fetch_failed" });
        continue;
      }
    }
    results.push(await ingestBooking(b));
  }
  return { ok: true, results };
}

/**
 * Poll for bookings modified since a cut-off. The fallback for hotels that
 * haven't pasted the webhook URL into their Beds24 panel — and the safety net
 * for the ones that have, since webhooks can be dropped after retries.
 *
 * Scoped to the properties we've actually imported so we never sweep an
 * unrelated account, and idempotent by way of ingestOtaBooking.
 */
async function pollBookings({ sinceMinutes = 10 } = {}) {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };

  const properties = await Property.find({
    "channel.provider": "beds24",
    "channel.beds24PropertyId": { $ne: null },
  })
    .select("channel.beds24PropertyId")
    .lean();
  if (!properties.length) return { ok: true, scanned: 0, ingested: 0 };

  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
  let scanned = 0;
  let ingested = 0;

  for (const p of properties) {
    try {
      const data = await call("get", "/bookings", {
        params: {
          propertyId: Number(p.channel.beds24PropertyId),
          modifiedFrom: since.toISOString(),
        },
      });
      const bookings = Array.isArray(data?.data) ? data.data : [];
      scanned += bookings.length;
      for (const b of bookings) {
        const res = await ingestBooking(b);
        if (res?.ok) ingested++;
      }
    } catch (err) {
      logger.warn("[Beds24] poll failed", {
        propertyId: p.channel.beds24PropertyId,
        err: err.message,
      });
    }
  }

  if (scanned) {
    logger.info(`[Beds24] polled ${scanned} booking(s), ingested ${ingested}`);
  }
  return { ok: true, scanned, ingested };
}

module.exports = {
  isConfigured,
  setupFromInviteCode,
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
  pollBookings,
  sourceFromOta,
};
