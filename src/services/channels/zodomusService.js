/**
 * zodomusService — OTA connectivity via Zodomus (Booking.com, Expedia, Airbnb).
 *
 * Third channel provider alongside Channex and Beds24, chosen Nov 2026 as the
 * primary one: a developer-first REST API with published pricing
 * (€0.50 per room type per channel per month + €0.10 per reservation, €29/mo
 * account minimum, no platform fee).
 *
 * How Zodomus differs from the other two:
 *   - It is per CHANNEL, not per property. A hotel listed on Booking.com and
 *     Airbnb has a Booking.com property id AND an Airbnb listing, each activated
 *     separately. So a Property carries a list of channel links
 *     (`channel.zodomus[]`) and a RoomType carries one mapping per channel
 *     (`zodomusRooms[]`).
 *   - New bookings are PULLED from a reservations queue; no webhooks are
 *     documented. jobs/zodomusPollJob.js drains the queue every minute.
 *
 * Verified from https://www.zodomus.com/developers (public page):
 *   REST + JSON, base https://api.zodomus.com, HTTPS/TLS1.2+,
 *   HTTP Basic auth with the API User / API Password from the backoffice.
 *   Endpoints: GET /channels, GET /price-model, POST /property-activation,
 *   POST /property-check, POST /rooms-activation, GET /room-rates,
 *   POST /availability, POST /rates, GET /reservations-queue,
 *   GET /reservations, POST /reservations-createtest, Airbnb host endpoints.
 *
 * NOT yet verified (the field-level reference is only visible after sandbox
 * login): exact request/response field names. Every payload is built by one of
 * the `build*` functions below so correcting them is a one-place change, and
 * scripts/testZodomus.js pins their current shape.
 *
 * Env:
 *   ZODOMUS_API_USER       — backoffice → Development tab
 *   ZODOMUS_API_PASSWORD   — backoffice → Development tab
 *   ZODOMUS_API_BASE       — optional, default https://api.zodomus.com
 *   ZODOMUS_PRICE_MODEL_ID — optional, the price model used on activation
 */
const axios = require("axios");
const logger = require("../../utils/logger");
const Property = require("../../models/Property");
const RoomType = require("../../models/RoomType");

const BASE = (process.env.ZODOMUS_API_BASE || "https://api.zodomus.com").replace(
  /\/$/,
  "",
);
const USER = process.env.ZODOMUS_API_USER || "";
const PASS = process.env.ZODOMUS_API_PASSWORD || "";

const isConfigured = () => !!(USER && PASS && !USER.startsWith("your_"));

// ── Transport ────────────────────────────────────────────────────────────────

const http = () =>
  axios.create({
    baseURL: BASE,
    timeout: 20000,
    auth: { username: USER, password: PASS },
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });

/**
 * Zodomus reports failures in the body as well as the status. Normalise both
 * into a thrown Error with the provider's own words, so a sync that quietly
 * failed shows up in logs and in the connection card instead of nowhere.
 */
function assertOk(data, what) {
  const st = data?.status;
  const code = st?.returnCode ?? st?.code ?? data?.returnCode;
  const failed =
    data?.success === false ||
    (code !== undefined && Number(code) >= 400) ||
    data?.error;
  if (!failed) return data;
  const why =
    st?.returnMessage || st?.message || data?.message || data?.error || "unknown error";
  throw new Error(`Zodomus ${what} rejected: ${why}`);
}

async function call(method, path, { params, data, what } = {}) {
  if (!isConfigured()) throw new Error("Zodomus is not configured");
  try {
    const res = await http().request({ method, url: path, params, data });
    return assertOk(res.data, what || `${method.toUpperCase()} ${path}`);
  } catch (err) {
    if (err.response) {
      const d = err.response.data || {};
      const why =
        d?.status?.returnMessage || d?.message || d?.error || err.message;
      throw new Error(
        `Zodomus ${what || path} failed (${err.response.status}): ${why}`,
      );
    }
    throw err;
  }
}

// ── Channels ─────────────────────────────────────────────────────────────────

// Our booking-source vocabulary → how Zodomus names the channel. Resolved to
// numeric ids at runtime from GET /channels rather than hardcoded, so a new
// channel (Agoda is "coming soon" per their site) needs no code change.
const OTA_ALIASES = {
  booking_com: ["booking"],
  expedia: ["expedia"],
  airbnb: ["airbnb"],
  agoda: ["agoda"],
  traveloka: ["traveloka"],
  tiket: ["tiket"],
};

let channelCache = { at: 0, list: [] };
const CHANNEL_TTL_MS = 6 * 60 * 60 * 1000;

/** [{ id, name }] for every channel the account can use. Cached 6h. */
async function listChannels({ force = false } = {}) {
  if (!force && channelCache.list.length && Date.now() - channelCache.at < CHANNEL_TTL_MS) {
    return channelCache.list;
  }
  const data = await call("get", "/channels", { what: "channel list" });
  const rows = data?.channels || data?.data || (Array.isArray(data) ? data : []);
  const list = rows
    .map((c) => ({
      id: Number(c.id ?? c.channelId),
      name: String(c.name ?? c.channelName ?? ""),
    }))
    .filter((c) => c.id);
  channelCache = { at: Date.now(), list };
  return list;
}

/** Map a Zodomus channel id/name → our booking source enum. */
function sourceFromChannel(nameOrId, channels = channelCache.list) {
  let name = String(nameOrId || "");
  if (/^\d+$/.test(name)) {
    name = channels.find((c) => c.id === Number(name))?.name || name;
  }
  const s = name.toLowerCase();
  for (const [ota, keys] of Object.entries(OTA_ALIASES)) {
    if (keys.some((k) => s.includes(k))) return ota;
  }
  return "other_ota";
}

/** Our OTA key ("booking_com") → Zodomus channel id, or null if unavailable. */
async function channelIdFor(ota) {
  const keys = OTA_ALIASES[ota];
  if (!keys) return null;
  const list = await listChannels();
  return list.find((c) => keys.some((k) => c.name.toLowerCase().includes(k)))?.id ?? null;
}

// ── Payload builders (the only place field names live) ───────────────────────

const dateStr = (d) => new Date(d).toISOString().slice(0, 10);

function buildPropertyActivation({ channelId, otaPropertyId, priceModelId }) {
  const body = { channelId: Number(channelId), propertyId: String(otaPropertyId) };
  const pm = priceModelId || process.env.ZODOMUS_PRICE_MODEL_ID;
  if (pm) body.priceModelId = Number(pm);
  return body;
}

function buildRoomsActivation({ channelId, otaPropertyId, rooms }) {
  return {
    channelId: Number(channelId),
    propertyId: String(otaPropertyId),
    rooms: rooms.map((r) => ({
      roomId: String(r.roomId),
      roomName: r.roomName || "",
      quantity: Number(r.quantity || 1),
      status: 1,
      rates: (r.rates || []).map((rt) => ({
        rateId: String(rt.rateId),
        rateName: rt.rateName || "",
        status: 1,
      })),
    })),
  };
}

/** `dateTo` is INCLUSIVE on the channel side; our ranges are half-open. */
function buildAvailability({ channelId, otaPropertyId, roomId, from, toInclusive, availability }) {
  return {
    channelId: Number(channelId),
    propertyId: String(otaPropertyId),
    roomId: String(roomId),
    dateFrom: dateStr(from),
    dateTo: dateStr(toInclusive),
    availability: Math.max(0, Number(availability) || 0),
  };
}

function buildRates({ channelId, otaPropertyId, roomId, rateId, from, toInclusive, price, currency }) {
  return {
    channelId: Number(channelId),
    propertyId: String(otaPropertyId),
    roomId: String(roomId),
    rateId: String(rateId),
    dateFrom: dateStr(from),
    dateTo: dateStr(toInclusive),
    currencyCode: currency || "USD",
    prices: { price: Number(price) },
  };
}

// ── Mapping / activation ─────────────────────────────────────────────────────

/** Room types + rate plans the channel holds for a property (for mapping). */
async function getRoomRates(channelId, otaPropertyId) {
  const data = await call("get", "/room-rates", {
    params: { channelId: Number(channelId), propertyId: String(otaPropertyId) },
    what: "room-rates",
  });
  const rooms = data?.rooms || data?.data?.rooms || data?.data || [];
  return (Array.isArray(rooms) ? rooms : []).map((r) => ({
    roomId: String(r.id ?? r.roomId),
    roomName: r.name ?? r.roomName ?? "Room",
    quantity: Number(r.quantity ?? r.qty ?? 1) || 1,
    rates: (r.rates || r.ratePlans || []).map((rt) => ({
      rateId: String(rt.id ?? rt.rateId),
      rateName: rt.name ?? rt.rateName ?? "",
    })),
  }));
}

/**
 * Connect one OTA listing of a hotel through Zodomus:
 *   1. activate the property on that channel,
 *   2. read its rooms + rates and activate them,
 *   3. map each channel room onto one of our RoomTypes (by name, else create).
 * Idempotent: re-running refreshes the same mapping.
 *
 * @param {object} property      our Property doc
 * @param {object} opts
 * @param {string} opts.ota            "booking_com" | "airbnb" | "expedia" | ...
 * @param {string} opts.otaPropertyId  the hotel's id on that OTA
 */
async function connectChannel(property, { ota, otaPropertyId }) {
  const channelId = await channelIdFor(ota);
  if (!channelId) throw new Error(`Zodomus does not offer ${ota} on this account`);
  if (!otaPropertyId) throw new Error("The property id on the OTA is required");

  await call("post", "/property-activation", {
    data: buildPropertyActivation({ channelId, otaPropertyId }),
    what: "property activation",
  });

  const rooms = await getRoomRates(channelId, otaPropertyId);
  if (rooms.length) {
    await call("post", "/rooms-activation", {
      data: buildRoomsActivation({ channelId, otaPropertyId, rooms }),
      what: "rooms activation",
    });
  }

  const existing = await RoomType.find({ propertyId: property._id });
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const mapped = [];
  for (const r of rooms) {
    let rt =
      existing.find((x) =>
        (x.zodomusRooms || []).some(
          (m) => m.channelId === channelId && m.roomId === r.roomId,
        ),
      ) || existing.find((x) => norm(x.name) === norm(r.roomName));
    if (!rt) {
      rt = await RoomType.create({
        workspaceId: property.workspaceId,
        propertyId: property._id,
        name: r.roomName,
        unitsCount: r.quantity,
        currency: property.currency || "USD",
      });
      existing.push(rt);
    }
    const link = {
      channelId,
      ota,
      roomId: r.roomId,
      rateId: r.rates[0]?.rateId || null,
    };
    rt.zodomusRooms = [
      ...(rt.zodomusRooms || []).filter((m) => m.channelId !== channelId),
      link,
    ];
    await rt.save();
    mapped.push({ roomTypeId: rt._id, name: rt.name, ...link });
  }

  const links = (property.channel?.zodomus || []).filter((l) => l.channelId !== channelId);
  links.push({ channelId, ota, otaPropertyId: String(otaPropertyId), activatedAt: new Date() });
  const otas = new Set([...(property.channel?.connectedOtas || []), ota]);
  await Property.updateOne(
    { _id: property._id },
    {
      $set: {
        "channel.provider": "zodomus",
        "channel.status": "connected",
        "channel.zodomus": links,
        "channel.connectedOtas": [...otas],
        "channel.lastSyncAt": new Date(),
        "channel.lastError": null,
        "channel.sync.state": "imported",
        "channel.sync.lastCheckedAt": new Date(),
      },
    },
  );

  logger.info(
    `[Zodomus] connected ${ota} property=${otaPropertyId} → ${property._id} rooms=${mapped.length}`,
  );
  return { channelId, rooms: mapped };
}

/** Is the property live on that channel? Used by the connection card. */
async function checkProperty(channelId, otaPropertyId) {
  return call("post", "/property-check", {
    data: { channelId: Number(channelId), propertyId: String(otaPropertyId) },
    what: "property check",
  });
}

// ── Airbnb (host-level OAuth, then listings) ─────────────────────────────────

const airbnbHostActivation = (data) =>
  call("post", "/airbnb-host-activation", { data, what: "airbnb host activation" });
const airbnbHostStatus = (params) =>
  call("get", "/airbnb-host-status", { params, what: "airbnb host status" });
const airbnbListings = (params) =>
  call("get", "/airbnb-listings", { params, what: "airbnb listings" });

// ── Availability + rate pushes ───────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

/** Which channel links of a property a room type is mapped on. */
function linksFor(property, roomType) {
  const props = property?.channel?.zodomus || [];
  return (roomType?.zodomusRooms || [])
    .map((m) => ({ ...m, link: props.find((p) => p.channelId === m.channelId) }))
    .filter((m) => m.link && m.roomId);
}

/**
 * Recompute availability for [from, to) and push it to every channel the room
 * is mapped on, collapsing runs of equal nights into one call each.
 */
async function pushAvailabilityRange(property, roomType, from, to) {
  if (!isConfigured()) return;
  const targets = linksFor(property, roomType);
  if (!targets.length) {
    logger.warn("[Zodomus] no channel mapping for room " + roomType._id);
    return;
  }
  const { nightlyAvailability, DAY_MS } = require("../hotel/availability");
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  const nights = await nightlyAvailability(roomType, from, days);

  const runs = [];
  for (const n of nights) {
    const last = runs[runs.length - 1];
    if (last && last.availability === n.available) last.toInclusive = n.date;
    else runs.push({ from: n.date, toInclusive: n.date, availability: n.available });
  }

  for (const t of targets) {
    for (const run of runs) {
      await call("post", "/availability", {
        data: buildAvailability({
          channelId: t.channelId,
          otaPropertyId: t.link.otaPropertyId,
          roomId: t.roomId,
          ...run,
        }),
        what: "availability push",
      });
    }
    logger.info(
      `[Zodomus] availability pushed ${t.ota} room=${t.roomId} ranges=${runs.length}`,
    );
  }
}

/** Push one nightly rate for [from, to) to every mapped channel. */
async function pushRateRange(property, roomType, from, to, rate) {
  if (!isConfigured()) return;
  const targets = linksFor(property, roomType).filter((t) => t.rateId);
  if (!targets.length) {
    logger.warn("[Zodomus] no rate mapping for room " + roomType._id);
    return;
  }
  const toInclusive = new Date(to.getTime() - DAY);
  for (const t of targets) {
    await call("post", "/rates", {
      data: buildRates({
        channelId: t.channelId,
        otaPropertyId: t.link.otaPropertyId,
        roomId: t.roomId,
        rateId: t.rateId,
        from,
        toInclusive,
        price: rate,
        currency: property.currency,
      }),
      what: "rate push",
    });
    logger.info(`[Zodomus] rate pushed ${t.ota} room=${t.roomId} rate=${rate}`);
  }
}

// ── Reservations ─────────────────────────────────────────────────────────────

/** Zodomus reservation status → our two-state view of a stay. */
function statusFrom(r) {
  const s = String(r?.status ?? r?.reservationStatus ?? "").toLowerCase();
  if (s.includes("cancel") || s === "3") return "cancelled";
  return "confirmed";
}

/**
 * Normalise one reservation into the shape ingestOtaBooking expects. Returns
 * one entry per booked room, since a channel reservation can hold several.
 */
function normaliseReservation(r, { channelId, otaPropertyId }) {
  const res = r?.reservation || r || {};
  const customer = res.customer || res.guest || {};
  const rooms = res.rooms || res.roomStays || [res];
  const id = String(res.id ?? res.reservationId ?? "");
  return rooms.map((room, i) => ({
    otaReservationId: `zodomus:${channelId}:${id}${rooms.length > 1 ? `:${i}` : ""}`,
    channelId,
    otaPropertyId,
    roomId: String(room.id ?? room.roomId ?? ""),
    status: statusFrom(res),
    checkIn: room.arrivalDate ?? room.checkIn ?? res.arrivalDate ?? res.checkIn,
    checkOut: room.departureDate ?? room.checkOut ?? res.departureDate ?? res.checkOut,
    guestName:
      room.guestName ||
      [customer.firstName ?? customer.name, customer.lastName ?? customer.surname]
        .filter(Boolean)
        .join(" "),
    guestPhone: customer.telephone || customer.phone || "",
    guestEmail: customer.email || "",
    adults: Number(room.numberOfAdults ?? room.adults ?? res.adults ?? 2) || 2,
    children: Number(room.numberOfChildren ?? room.children ?? 0) || 0,
    totalAmount: Number(room.totalPrice ?? room.price ?? res.totalPrice ?? 0) || 0,
    currency: res.currencyCode || res.currency || undefined,
  }));
}

async function ingestReservation(r, link) {
  const property = await Property.findOne({
    "channel.zodomus": {
      $elemMatch: { channelId: link.channelId, otaPropertyId: String(link.otaPropertyId) },
    },
  });
  if (!property) return [{ ok: false, reason: "unknown_property" }];

  const { ingestOtaBooking } = require("../hotel/bookingService");
  const out = [];
  for (const b of normaliseReservation(r, link)) {
    const roomType =
      (b.roomId &&
        (await RoomType.findOne({
          propertyId: property._id,
          zodomusRooms: { $elemMatch: { channelId: link.channelId, roomId: b.roomId } },
        }))) ||
      (await RoomType.findOne({ propertyId: property._id }));
    if (!roomType) {
      out.push({ ok: false, reason: "unknown_room" });
      continue;
    }
    out.push(
      await ingestOtaBooking({
        property,
        roomType,
        otaReservationId: b.otaReservationId,
        source: sourceFromChannel(link.channelId),
        status: b.status,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        guestName: b.guestName,
        guestPhone: b.guestPhone,
        guestEmail: b.guestEmail,
        adults: b.adults,
        children: b.children,
        totalAmount: b.totalAmount,
        currency: b.currency || property.currency,
        raw: r,
      }),
    );
  }
  return out;
}

/**
 * Drain the reservations queue for every connected channel link. The queue
 * holds ids of new/modified/cancelled reservations; we fetch each and ingest.
 * ingestOtaBooking is idempotent on otaReservationId, so a repeat is an update.
 */
async function pollBookings() {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  const properties = await Property.find({
    "channel.provider": "zodomus",
    "channel.zodomus.0": { $exists: true },
  })
    .select("channel.zodomus")
    .lean();
  if (!properties.length) return { ok: true, scanned: 0, ingested: 0 };

  await listChannels().catch(() => {}); // warm the name cache for sourceFromChannel

  let scanned = 0;
  let ingested = 0;
  for (const p of properties) {
    for (const link of p.channel.zodomus) {
      try {
        const q = await call("get", "/reservations-queue", {
          params: { channelId: link.channelId, propertyId: link.otaPropertyId },
          what: "reservations queue",
        });
        const items = q?.reservations || q?.data || (Array.isArray(q) ? q : []);
        for (const item of items) {
          const reservationId = item.id ?? item.reservationId ?? item;
          scanned++;
          const full = await call("get", "/reservations", {
            params: {
              channelId: link.channelId,
              propertyId: link.otaPropertyId,
              reservationId,
            },
            what: "reservation fetch",
          });
          const results = await ingestReservation(full, link);
          ingested += results.filter((x) => x?.ok !== false).length;
        }
      } catch (err) {
        logger.warn("[Zodomus] poll failed", {
          ota: link.ota,
          propertyId: link.otaPropertyId,
          err: err.message,
        });
      }
    }
  }
  if (scanned) logger.info(`[Zodomus] polled ${scanned} reservation(s), ingested ${ingested}`);
  return { ok: true, scanned, ingested };
}

/** Sandbox only: ask Zodomus to create a test reservation. */
const createTestReservation = (data) =>
  call("post", "/reservations-createtest", { data, what: "test reservation" });

/** Account sanity check for the admin readiness page. */
async function ping() {
  const data = await call("get", "/account", { what: "account" });
  return { ok: true, account: data?.account || data };
}

// ── Guest messaging ──────────────────────────────────────────────────────────
// Zodomus lists "Guest Communications" as an advanced API, but its endpoints
// are only documented behind the sandbox login (asked in our partner email).
// Until they're confirmed this driver reports itself unavailable, so OTA
// messaging for Zodomus properties is skipped cleanly rather than guessed at.
// When the docs arrive: implement pollNew / fetchThread / send with the same
// normalised shape as channexService.messaging and flip isAvailable.
const messaging = {
  isAvailable: () => false,
  async pollNew() {
    return [];
  },
  async fetchThread() {
    return [];
  },
  async send() {
    return {
      success: false,
      error: "Guest messaging through Zodomus isn't switched on yet.",
    };
  },
};

module.exports = {
  messaging,
  isConfigured,
  ping,
  listChannels,
  channelIdFor,
  sourceFromChannel,
  getRoomRates,
  connectChannel,
  checkProperty,
  airbnbHostActivation,
  airbnbHostStatus,
  airbnbListings,
  pushAvailabilityRange,
  pushRateRange,
  pollBookings,
  createTestReservation,
  // exported for tests
  _build: { buildPropertyActivation, buildRoomsActivation, buildAvailability, buildRates },
  _normaliseReservation: normaliseReservation,
  _statusFrom: statusFrom,
};
