/**
 * wubookService — WuBook "WooDoo" channel manager (the owner's choice, Nov 2026).
 *
 * Model (from WuBook's partner reply): Botlify holds ONE Corporate account;
 * every hotel is a sub-account / property identified by its `lcode`. Inside a
 * property the hotel's booking sites ("channels" — one Booking.com hotel ID,
 * one Airbnb account, Expedia, Trip.com…) are connected in the WooDoo panel.
 * WuBook's own rooms are the master inventory: each OTA's rooms are mapped to
 * them inside WooDoo. So Botlify mirrors WuBook rooms only, and a sale on ANY
 * site closes the room on every other site through WuBook. Multi-channel per
 * hotel needs no extra mapping on our side.
 *
 * Billing: €5 per connected channel / month (4.75 from 81, 4.50 from 101), no
 * setup fees, 2-month trial.
 *
 * Two APIs:
 *  1. Classic Wired (XML-RPC) — rooms, availability, prices, reservations.
 *     Docs: tdocs.wubook.net/wired/*.html. Permanent token from
 *     wubook.net/wauth/wauth/dash/wired/, passed as the first argument; most
 *     calls take `lcode` second. Responses are [retcode, result]; 0 = OK.
 *       fetch_rooms(token, lcode, ancillary)
 *       update_avail(token, lcode, dfrom "DD/MM/YYYY", [{id, days:[{avail}]}])
 *       get_pricing_plans(token, lcode)        pid 0 = "WuBook Parity" (default)
 *       update_plan_prices(token, lcode, pid, dfrom, {roomId: [price,…]})
 *       fetch_new_bookings(token, lcode, ancillary=0, mark=1)
 *       fetch_booking(token, lcode, rcode)
 *       push_activation(token, lcode, url)     POST {rcode, lcode} per new/changed booking
 *       get_otas(token, lcode)                 the property's connected channels
 *  2. Wired JSON (JSON-RPC 2.0) — guest messaging + webhooks.
 *     POST https://wired-json.wubook.net/api/  header X-API-KEY.
 *       messages_thread:search   {property_id, channel_id, reservation_id?}
 *       messages_thread:retrieve {property_id, channel_id, thread_ids}  (msgs >1 week return blank)
 *       messages_thread:send     {property_id, channel_id, thread_id, message_text}  (async)
 *     Webhooks: messages_thread:notify (thread_updated), communication:notify
 *     (reservation_new). Docs cover Airbnb messaging; WuBook's partner email says
 *     Booking.com messaging is supported too — same calls with the Booking.com
 *     channel id.
 *
 * Env:
 *   WUBOOK_TOKEN          classic Wired permanent token (corporate account)
 *   WUBOOK_API_KEY        Wired JSON API key (messaging)
 *   WUBOOK_XMLRPC_URL     default https://wired.wubook.net/xrws/
 *   WUBOOK_JSON_URL       default https://wired-json.wubook.net/api/
 *   WUBOOK_WEBHOOK_TOKEN  shared secret in our push/webhook URLs
 */
const axios = require("axios");
const logger = require("../../utils/logger");
const Property = require("../../models/Property");
const RoomType = require("../../models/RoomType");
const { xmlrpcCall } = require("../../utils/xmlrpc");

const XMLRPC_URL = process.env.WUBOOK_XMLRPC_URL || "https://wired.wubook.net/xrws/";
const JSON_URL = process.env.WUBOOK_JSON_URL || "https://wired-json.wubook.net/api/";
const TOKEN = () => process.env.WUBOOK_TOKEN || "";
const API_KEY = () => process.env.WUBOOK_API_KEY || "";
const WEBHOOK_TOKEN = () => process.env.WUBOOK_WEBHOOK_TOKEN || "";

const isConfigured = () => !!TOKEN();
const messagingConfigured = () => !!API_KEY();

// ── Transport ────────────────────────────────────────────────────────────────

/** Classic Wired call; unwraps [retcode, result] and throws on retcode != 0. */
async function wired(method, ...args) {
  if (!isConfigured()) throw new Error("WuBook is not configured");
  const res = await xmlrpcCall(XMLRPC_URL, method, [TOKEN(), ...args]);
  if (Array.isArray(res)) {
    const [code, result] = res;
    if (Number(code) !== 0) {
      const e = new Error(`WuBook ${method} failed (${code}): ${typeof result === "string" ? result : JSON.stringify(result)}`);
      e.code = code;
      throw e;
    }
    return result;
  }
  return res;
}

let rpcId = 0;
/** Wired JSON call (JSON-RPC 2.0). */
async function wiredJson(method, params = {}) {
  if (!messagingConfigured()) throw new Error("WuBook messaging is not configured");
  const { data } = await axios.post(
    JSON_URL,
    { jsonrpc: "2.0", id: ++rpcId, method, params },
    { headers: { "X-API-KEY": API_KEY(), "Content-Type": "application/json" }, timeout: 20000 },
  );
  if (data?.error) {
    throw new Error(`WuBook ${method}: ${data.error.message || JSON.stringify(data.error)}`);
  }
  return data?.result;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");
/** Date → "DD/MM/YYYY" (UTC day, matching our night boundaries). */
const euDate = (d) => {
  const x = new Date(d);
  return `${pad(x.getUTCDate())}/${pad(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}`;
};
/** "DD/MM/YYYY[ hh:mm:ss]" → Date (UTC midnight for dates). */
const parseEuDate = (s) => {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return s ? new Date(s) : null;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
};
const DAY = 24 * 60 * 60 * 1000;

// ── Channels (the hotel's booking sites) ─────────────────────────────────────

/** Our booking-source vocabulary from a WuBook channel name/tag. */
function sourceFromOta(name = "") {
  const s = String(name).toLowerCase();
  if (s.includes("airbnb")) return "airbnb";
  if (s.includes("booking")) return "booking_com";
  if (s.includes("expedia")) return "expedia";
  if (s.includes("trip.com") || s.includes("ctrip") || s === "trip") return "trip_com";
  if (s.includes("agoda")) return "agoda";
  if (s.includes("traveloka")) return "traveloka";
  if (s.includes("vrbo") || s.includes("homeaway")) return "vrbo";
  return "other_ota";
}

/** The property's connected channels → [{channelId, ota, name}]. */
async function listChannels(lcode) {
  let rows = [];
  try {
    rows = (await wired("get_otas", Number(lcode))) || [];
  } catch (err) {
    logger.warn(`[WuBook] get_otas failed lcode=${lcode}: ${err.message}`);
    return [];
  }
  return (Array.isArray(rows) ? rows : Object.values(rows || {})).map((c) => {
    const name = c.tag || c.name || c.channel_name || c.ota || String(c.ctype ?? "");
    return { channelId: String(c.id ?? c.channel_id ?? c.ctype), ota: sourceFromOta(name), name: String(name) };
  });
}

// ── Import: WuBook property → our Property + RoomTypes ──────────────────────

/**
 * Import (or refresh) one WuBook property into a workspace. Idempotent: re-run
 * updates the same docs (matched by lcode / WuBook room id).
 */
async function importProperty(workspaceId, lcode, { name } = {}) {
  const code = String(lcode);
  const rooms = (await wired("fetch_rooms", Number(code), 0)) || [];
  // Virtual rooms (subroom != 0) are WuBook derivations of a real room; they
  // share its inventory, so we mirror only the real ones.
  const real = rooms.filter((r) => !Number(r.subroom));
  const channels = await listChannels(code);
  const connectedOtas = [...new Set(channels.map((c) => c.ota).filter((o) => o !== "other_ota"))];

  const property = await Property.findOneAndUpdate(
    { "channel.wubookLcode": code },
    {
      $set: {
        workspaceId,
        ...(name ? { name } : {}),
        "channel.provider": "wubook",
        "channel.status": "connected",
        "channel.wubookLcode": code,
        "channel.wubookChannels": channels,
        "channel.connectedOtas": connectedOtas,
        "channel.lastSyncAt": new Date(),
        "channel.lastError": null,
        "channel.sync.state": connectedOtas.length ? "live" : "imported",
        "channel.sync.lastCheckedAt": new Date(),
      },
      // Only name a brand-new property when we weren't given one ($set and
      // $setOnInsert can't both touch "name").
      ...(name ? {} : { $setOnInsert: { name: `Property ${code}` } }),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const saved = [];
  for (const r of real) {
    const doc = await RoomType.findOneAndUpdate(
      { propertyId: property._id, wubookRoomId: String(r.id) },
      {
        $set: {
          workspaceId,
          propertyId: property._id,
          name: r.name || r.shortname || "Room",
          unitsCount: Math.max(1, Number(r.availability) || 1),
          maxAdults: Number(r.men ?? r.occupancy ?? 2) || 2,
          maxChildren: Number(r.children ?? 0) || 0,
          maxOccupancy: Number(r.occupancy ?? 2) || 2,
          ...(Number(r.price) > 0 ? { baseRate: Number(r.price) } : {}),
          wubookRoomId: String(r.id),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    saved.push(doc);
  }

  try {
    await registerPush(code);
  } catch (err) {
    logger.warn(`[WuBook] push activation failed lcode=${code}: ${err.message} (the poll covers it)`);
  }
  logger.info(`[WuBook] imported lcode=${code} → ws=${workspaceId} rooms=${saved.length} channels=${channels.length}`);
  return { property, roomTypes: saved, channels };
}

// ── Availability + rates ─────────────────────────────────────────────────────

/** Push our availability for [from, to) to WuBook → every connected site. */
async function pushAvailabilityRange(property, roomType, from, to) {
  if (!isConfigured()) return;
  const lcode = property?.channel?.wubookLcode;
  if (!lcode || !roomType.wubookRoomId) {
    logger.warn(`[WuBook] no mapping for room ${roomType._id}`);
    return;
  }
  const { nightlyAvailability, DAY_MS } = require("../hotel/availability");
  const days = Math.max(1, Math.round((to - from) / DAY_MS));
  const nights = await nightlyAvailability(roomType, from, days);
  if (!nights.length) return;
  await wired("update_avail", Number(lcode), euDate(nights[0].date), [
    { id: Number(roomType.wubookRoomId), days: nights.map((n) => ({ avail: Math.max(0, n.available) })) },
  ]);
  logger.info(`[WuBook] availability pushed lcode=${lcode} room=${roomType.wubookRoomId} nights=${nights.length}`);
}

/** Push one nightly rate for [from, to) on the default plan (pid 0). */
async function pushRateRange(property, roomType, from, to, rate) {
  if (!isConfigured()) return;
  const lcode = property?.channel?.wubookLcode;
  if (!lcode || !roomType.wubookRoomId) return;
  const nights = Math.max(1, Math.round((to - from) / DAY));
  const pid = Number(property.channel?.wubookPlanId ?? 0);
  await wired("update_plan_prices", Number(lcode), pid, euDate(from), {
    [String(roomType.wubookRoomId)]: Array.from({ length: nights }, () => Number(rate)),
  });
  logger.info(`[WuBook] rate pushed lcode=${lcode} room=${roomType.wubookRoomId} rate=${rate}`);
}

// ── Reservations ─────────────────────────────────────────────────────────────

function pushCallbackUrl() {
  const base = (process.env.API_PUBLIC_URL || "https://velox-whatbot-backend.onrender.com").replace(/\/$/, "");
  return `${base}/api/wubook/push?token=${encodeURIComponent(WEBHOOK_TOKEN())}`;
}
const verifyWebhookToken = (t) => !!WEBHOOK_TOKEN() && t === WEBHOOK_TOKEN();

async function registerPush(lcode) {
  if (!WEBHOOK_TOKEN()) return null;
  await wired("push_activation", Number(lcode), pushCallbackUrl(), 0);
  return { url: pushCallbackUrl() };
}

/** WuBook status → ours. 1 confirmed, 2/4 pending/accepted, 3 refused, 5/6 cancelled. */
const statusFrom = (s) => ([3, 5, 6].includes(Number(s)) ? "cancelled" : "confirmed");

/** Normalise a WuBook reservation; one entry per booked room. */
function normaliseBooking(b, channels = []) {
  const chan = channels.find((c) => String(c.channelId) === String(b.id_channel));
  const source = chan ? chan.ota : Number(b.id_channel) ? "other_ota" : "direct";
  const roomIds = (b.booked_rooms || []).map((r) => r.room_id).filter(Boolean);
  const fallbackIds = String(b.rooms || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const ids = roomIds.length ? roomIds : fallbackIds.length ? fallbackIds : [null];
  return ids.map((roomId, i) => ({
    otaReservationId: `wubook:${b.reservation_code}${ids.length > 1 ? `#${i}` : ""}`,
    channelReservationCode: b.channel_reservation_code || null,
    roomId: roomId ? String(roomId) : null,
    source,
    status: statusFrom(b.status),
    checkIn: parseEuDate(b.date_arrival),
    checkOut: parseEuDate(b.date_departure),
    guestName: [b.customer_name, b.customer_surname].filter(Boolean).join(" "),
    guestPhone: b.customer_phone || "",
    guestEmail: b.customer_mail || "",
    adults: Number(b.men ?? 2) || 2,
    children: Number(b.children ?? 0) || 0,
    totalAmount: Number(b.amount ?? 0) / ids.length,
    currency: b.currency || undefined,
  }));
}

async function ingestBooking(b, property) {
  const prop =
    property || (await Property.findOne({ "channel.wubookLcode": String(b.lcode ?? b.property_id ?? "") }));
  if (!prop) return [{ ok: false, reason: "unknown_property" }];
  const { ingestOtaBooking } = require("../hotel/bookingService");
  const out = [];
  for (const n of normaliseBooking(b, prop.channel?.wubookChannels || [])) {
    const roomType =
      (n.roomId && (await RoomType.findOne({ propertyId: prop._id, wubookRoomId: n.roomId }))) ||
      (await RoomType.findOne({ propertyId: prop._id }));
    if (!roomType) {
      out.push({ ok: false, reason: "unknown_room" });
      continue;
    }
    out.push(
      await ingestOtaBooking({
        property: prop,
        roomType,
        otaReservationId: n.otaReservationId,
        source: n.source,
        status: n.status,
        checkIn: n.checkIn,
        checkOut: n.checkOut,
        guestName: n.guestName,
        guestPhone: n.guestPhone,
        guestEmail: n.guestEmail,
        adults: n.adults,
        children: n.children,
        totalAmount: n.totalAmount,
        currency: n.currency || prop.currency,
        raw: b,
      }),
    );
  }
  return out;
}

/** Push callback: WuBook POSTs {rcode, lcode} → fetch and ingest. */
async function handlePush({ rcode, lcode }) {
  if (!rcode || !lcode) return { ok: false, reason: "missing_params" };
  const property = await Property.findOne({ "channel.wubookLcode": String(lcode) });
  if (!property) return { ok: false, reason: "unknown_property" };
  const b = await wired("fetch_booking", Number(lcode), String(rcode));
  const booking = Array.isArray(b) ? b[0] : b;
  return { ok: true, results: await ingestBooking({ ...booking, lcode }, property) };
}

/** Safety net: pull (and mark) new/changed bookings for every WuBook property. */
async function pollBookings() {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  const props = await Property.find({ "channel.provider": "wubook", "channel.wubookLcode": { $ne: null } });
  let scanned = 0;
  let ingested = 0;
  for (const p of props) {
    try {
      const list = (await wired("fetch_new_bookings", Number(p.channel.wubookLcode), 0, 1)) || [];
      for (const b of list) {
        scanned++;
        const r = await ingestBooking(b, p);
        ingested += r.filter((x) => x?.ok !== false).length;
      }
    } catch (err) {
      logger.warn(`[WuBook] poll failed lcode=${p.channel.wubookLcode}: ${err.message}`);
    }
  }
  if (scanned) logger.info(`[WuBook] polled ${scanned} reservation(s), ingested ${ingested}`);
  return { ok: true, scanned, ingested };
}

/** Which OTAs are live for the connection card. */
async function listConnectedChannels(lcode) {
  return [...new Set((await listChannels(lcode)).map((c) => c.ota).filter((o) => o !== "other_ota"))];
}

// ── Guest messaging (Wired JSON) ─────────────────────────────────────────────
// Thread ids are composite "lcode|channelId|threadId" so a reply knows exactly
// where to go without another lookup.

const MSG_OTAS = new Set(["airbnb", "booking_com"]);
const splitThread = (t) => {
  const [lcode, channelId, threadId] = String(t || "").split("|");
  return { lcode, channelId, threadId };
};
const listOf = (r, ...keys) => {
  if (Array.isArray(r)) return r;
  for (const k of keys) if (Array.isArray(r?.[k])) return r[k];
  return [];
};

function normaliseThreadMessages(lcode, channel, thread) {
  const threadId = String(thread.id ?? thread.thread_id);
  const reservation = thread.reservation_id ?? thread.reservation_code ?? null;
  const guestName = thread.guest_name || thread.title || [thread.customer_name, thread.customer_surname].filter(Boolean).join(" ");
  return listOf(thread, "messages", "items").map((m, i) => {
    const who = String(m.sender ?? m.author ?? m.from ?? m.direction ?? "").toLowerCase();
    const sender =
      who.includes("guest") || who.includes("customer") || who === "in" || who === "inbound"
        ? "guest"
        : who.includes("system")
          ? "system"
          : "hotel";
    return {
      provider: "wubook",
      ota: channel.ota,
      threadId: `${lcode}|${channel.channelId}|${threadId}`,
      bookingRef: reservation ? String(reservation) : null,
      providerPropertyId: String(lcode),
      guestName,
      messageId: String(m.id ?? m.message_id ?? `${threadId}:${m.date ?? m.created ?? i}`),
      text: m.message_text ?? m.text ?? m.message ?? m.body ?? "",
      attachments: m.attachments || [],
      sender,
      at: m.date || m.created_at || m.created || m.timestamp || new Date().toISOString(),
    };
  });
}

async function fetchThreads(lcode, channel, threadIds) {
  if (!threadIds.length) return [];
  const r = await wiredJson("messages_thread:retrieve", {
    property_id: Number(lcode),
    channel_id: Number(channel.channelId),
    thread_ids: threadIds.map((t) => (/^\d+$/.test(String(t)) ? Number(t) : t)),
  });
  return listOf(r, "threads", "items").flatMap((th) => normaliseThreadMessages(lcode, channel, th));
}

const messaging = {
  isAvailable: () => isConfigured() && messagingConfigured(),

  async pollNew({ since }) {
    const cutoff = new Date(since).getTime();
    const props = await Property.find({ "channel.provider": "wubook", "channel.wubookLcode": { $ne: null } }).lean();
    const out = [];
    for (const p of props) {
      for (const ch of (p.channel.wubookChannels || []).filter((c) => MSG_OTAS.has(c.ota))) {
        try {
          const threads = listOf(
            await wiredJson("messages_thread:search", {
              property_id: Number(p.channel.wubookLcode),
              channel_id: Number(ch.channelId),
            }),
            "threads",
            "items",
          );
          // Only re-read threads with recent activity when the API says so.
          const ids = threads
            .filter((t) => {
              const last = new Date(t.last_message_date || t.updated_at || t.last_update || 0).getTime();
              return !last || last >= cutoff;
            })
            .map((t) => t.id ?? t.thread_id)
            .filter((x) => x !== undefined);
          const msgs = await fetchThreads(p.channel.wubookLcode, ch, ids);
          out.push(...msgs.filter((m) => new Date(m.at).getTime() >= cutoff || isNaN(new Date(m.at))));
        } catch (err) {
          logger.warn(`[WuBook] message poll failed lcode=${p.channel.wubookLcode} ch=${ch.channelId}: ${err.message}`);
        }
      }
    }
    return out;
  },

  async fetchThread(compositeId) {
    const { lcode, channelId, threadId } = splitThread(compositeId);
    const p = await Property.findOne({ "channel.wubookLcode": String(lcode) }).lean();
    const ch = (p?.channel?.wubookChannels || []).find((c) => String(c.channelId) === String(channelId)) || {
      channelId,
      ota: "airbnb",
    };
    return fetchThreads(lcode, ch, [threadId]);
  },

  async send({ threadId, text }) {
    const { lcode, channelId, threadId: tid } = splitThread(threadId);
    if (!lcode || !channelId || !tid) return { success: false, error: "No WuBook message thread for this guest." };
    try {
      await wiredJson("messages_thread:send", {
        property_id: Number(lcode),
        channel_id: Number(channelId),
        thread_id: /^\d+$/.test(tid) ? Number(tid) : tid,
        message_text: String(text || ""),
      });
      // Async on WuBook's side: failures arrive as a send_message_failed webhook.
      return { success: true, messageId: null };
    } catch (err) {
      logger.warn(`[WuBook] message send failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  },
};

/**
 * Wired JSON webhook (messages_thread:notify / communication:notify).
 * Returns what to do next so the controller can stay thin.
 */
function classifyWebhook(body = {}) {
  const method = String(body.method || body.type || "").toLowerCase();
  const p = body.params || body.data || body;
  const type = String(p.type || p.communication?.type || "").toLowerCase();
  if (method.includes("messages_thread") || type.includes("thread")) {
    const lcode = p.property_id ?? p.lcode;
    const channelId = p.channel_id;
    const threadId = p.thread_id ?? p.thread?.id;
    if (type.includes("failed")) return { kind: "send_failed", detail: p };
    if (lcode && channelId && threadId) return { kind: "thread", composite: `${lcode}|${channelId}|${threadId}` };
    return { kind: "messages_unknown" };
  }
  if (type.includes("reservation") || method.includes("communication")) {
    const lcode = p.property_id ?? p.lcode ?? p.reservation?.property_id;
    const rcode = p.reservation_code ?? p.rcode ?? p.reservation?.reservation_code ?? p.reservation_id;
    return { kind: "reservation", lcode, rcode };
  }
  return { kind: "ignore" };
}

// ── Automatic site onboarding (hotelier enters only their site's hotel ID) ──
//
// Wired WooDoo functions (tdocs.wubook.net/wired/woodoo.html):
//   get_channels_info(token)                         ctype catalogue (names)
//   new_ota(token, lcode, ctype[, tag])              add a site → chid
//   ota_running(token, lcode, chid)                  configured + active?
//   bcom_start_procedure(token, lcode, chid, bhid)   start with Booking.com hotel id
//   bcom_confirm_activation(token, lcode, chid)
//   bcom_init_channel(token, lcode, chid, currency)
//   bcom_rooms_rates(token, lcode, chid)             Booking.com rooms/rates to map
//   bcom_set_room_mapping(token, lcode, chid, rmap)  {bcomRoomId: wubookRoomId}
//   bcom_set_rate_mapping(token, lcode, chid, rmap)  {bcomRateId: pricingPlanId}
//   exp_start_procedure / exp_init_channel(…, currency, fee, vat_taxes) /
//   exp_rooms_rates / exp_set_room_mapping / exp_set_rate_mapping — same for Expedia
//   new_room(token, lcode, woodoo, name, beds, defprice, avail, shortname, defboard)
//
// The ONE step no API can do: Booking.com and Expedia require the property
// owner to approve the channel manager in their own extranet. We start the
// procedure, tell the hotel exactly where to click, and a background job
// (advanceOnboarding, every few minutes) finishes everything the moment the
// approval lands: init → read rooms → create WuBook rooms → map rooms+rates →
// mirror into Botlify → live. Airbnb has no Wired API connect function — the
// host authorises Airbnb once (OAuth), so it is reported as "needs_host_login".
//
// State per site lives in property.channel.wubookOnboarding[]:
//   { ota, otaHotelId, chid, state, message, updatedAt }
//   state: starting → awaiting_approval → mapping → live | needs_host_login | error

const OTA_CTYPE_NAMES = {
  booking_com: /booking\.com|^booking$/i,
  expedia: /expedia/i,
  airbnb: /airbnb/i,
  trip_com: /trip\.com|ctrip/i,
};

let ctypeCache = null;
async function ctypeFor(ota) {
  if (!ctypeCache) {
    const info = (await wired("get_channels_info")) || {};
    const rows = Array.isArray(info)
      ? info
      : Object.entries(info).map(([ctype, v]) => ({ ctype, ...(typeof v === "object" ? v : { name: v }) }));
    ctypeCache = rows.map((r) => ({ ctype: Number(r.ctype ?? r.id), name: String(r.name || r.tag || "") }));
  }
  const re = OTA_CTYPE_NAMES[ota];
  return ctypeCache.find((c) => re && re.test(c.name))?.ctype ?? null;
}

const APPROVAL_STEPS = {
  booking_com:
    "In your Booking.com extranet: Account → Connectivity provider → search “WuBook” → Connect, and accept. Botlify finishes the rest automatically.",
  expedia:
    "In Expedia Partner Central: Rooms and rates → Connectivity settings → choose “WuBook” as your provider. Botlify finishes the rest automatically.",
  airbnb:
    "Airbnb needs you to log in once to authorise the connection (Airbnb's security rule). We'll send you a secure link — no settings to change.",
  trip_com:
    "Trip.com connections are switched on by our team within a working day — nothing to do on your side.",
};

async function setOnboarding(propertyId, ota, patch) {
  const prop = await Property.findById(propertyId);
  const list = (prop.channel?.wubookOnboarding || []).filter((o) => o.ota !== ota);
  const prev = (prop.channel?.wubookOnboarding || []).find((o) => o.ota === ota) || {};
  list.push({ ...prev.toObject?.() ?? prev, ota, ...patch, updatedAt: new Date() });
  await Property.updateOne({ _id: propertyId }, { $set: { "channel.wubookOnboarding": list } });
  return list.find((o) => o.ota === ota);
}

/** WuBook short room name: ≤4 chars, unique per property. */
function shortName(name, taken) {
  const base = String(name || "RM").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 3) || "RM";
  for (let i = 0; i < 100; i++) {
    const s = (i ? base.slice(0, 2) + String(i).padStart(2, "0") : base).slice(0, 4);
    if (!taken.has(s)) {
      taken.add(s);
      return s;
    }
  }
  return String(Date.now() % 10000);
}

const listRows = (r, ...keys) => {
  if (Array.isArray(r)) return r;
  for (const k of keys) {
    const v = r?.[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Object.entries(v).map(([id, x]) => ({ id, ...(typeof x === "object" ? x : { name: x }) }));
  }
  if (r && typeof r === "object") return Object.entries(r).map(([id, x]) => ({ id, ...(typeof x === "object" ? x : { name: x }) }));
  return [];
};

/**
 * Start connecting one booking site. Only input from the hotel: the site's
 * hotel/listing id. Returns the onboarding entry (state + what the hotel sees).
 */
async function startSiteConnection(property, { ota, otaHotelId }) {
  const lcode = property.channel?.wubookLcode;
  if (!lcode) throw Object.assign(new Error("Your channel account is being prepared — try again in a few minutes."), { status: 409 });
  const id = String(otaHotelId || "").trim();

  if (ota === "airbnb" || ota === "trip_com") {
    return setOnboarding(property._id, ota, {
      otaHotelId: id || null,
      state: ota === "airbnb" ? "needs_host_login" : "awaiting_team",
      message: APPROVAL_STEPS[ota],
    });
  }
  if (!["booking_com", "expedia"].includes(ota)) {
    throw Object.assign(new Error("Choose Booking.com, Expedia, Airbnb or Trip.com."), { status: 400 });
  }
  if (!/^\d{3,12}$/.test(id)) {
    throw Object.assign(
      new Error(ota === "booking_com" ? "Enter your Booking.com hotel ID (the number at the top of your extranet)." : "Enter your Expedia hotel ID."),
      { status: 400 },
    );
  }

  const existing = (property.channel?.wubookOnboarding || []).find((o) => o.ota === ota);
  let chid = existing?.chid;
  if (!chid) {
    const ctype = await ctypeFor(ota);
    if (!ctype) throw new Error(`WuBook doesn't offer ${ota} on this account`);
    chid = String(await wired("new_ota", Number(lcode), ctype, `botlify-${ota}`));
  }
  await wired(ota === "booking_com" ? "bcom_start_procedure" : "exp_start_procedure", Number(lcode), Number(chid), Number(id));
  logger.info(`[WuBook] ${ota} connection started lcode=${lcode} chid=${chid} hotel=${id}`);
  return setOnboarding(property._id, ota, {
    otaHotelId: id,
    chid,
    state: "awaiting_approval",
    message: APPROVAL_STEPS[ota],
  });
}

/** Map one approved Booking.com / Expedia site: init, rooms, rates, mirror. */
async function completeMapping(property, entry) {
  const lcode = Number(property.channel.wubookLcode);
  const chid = Number(entry.chid);
  const bcom = entry.ota === "booking_com";
  const currency = property.currency || "USD";
  if (bcom) await wired("bcom_init_channel", lcode, chid, currency);
  else await wired("exp_init_channel", lcode, chid, currency, 0, 0);

  const rr = await wired(bcom ? "bcom_rooms_rates" : "exp_rooms_rates", lcode, chid);
  const otaRooms = listRows(rr, "rooms");
  const otaRates = listRows(rr, "rates", "rateplans", "rate_plans");

  // Reuse WuBook rooms with the same name (a second site of the same hotel
  // maps onto the rooms the first site created), create the rest.
  const wbRooms = ((await wired("fetch_rooms", lcode, 0)) || []).filter((r) => !Number(r.subroom));
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const taken = new Set(wbRooms.map((r) => r.shortname).filter(Boolean));
  const roomMap = {};
  for (const r of otaRooms) {
    const otaId = String(r.id ?? r.room_id ?? r.roomid);
    const name = r.name || r.room_name || r.title || `Room ${otaId}`;
    let wb = wbRooms.find((x) => norm(x.name) === norm(name));
    if (!wb) {
      const beds = Math.max(1, Number(r.occupancy ?? r.max_occupancy ?? r.beds ?? 2) || 2);
      const units = Math.max(1, Number(r.units ?? r.quantity ?? r.number_of_rooms ?? r.availability ?? 1) || 1);
      const price = Math.max(1, Number(r.price ?? r.default_price ?? 100) || 100);
      const newId = await wired("new_room", lcode, 0, String(name).slice(0, 100), beds, price, units, shortName(name, taken), "nb");
      wb = { id: Number(Array.isArray(newId) ? newId[0] : newId), name };
      wbRooms.push(wb);
    }
    roomMap[otaId] = Number(wb.id);
  }
  // Every OTA rate → WuBook Parity plan (pid 0), so one rate push reaches all.
  const rateMap = {};
  for (const rt of otaRates) rateMap[String(rt.id ?? rt.rate_id ?? rt.rateid)] = 0;
  // Rates are sometimes nested under each room.
  for (const r of otaRooms) for (const rt of listRows(r, "rates", "rateplans")) rateMap[String(rt.id ?? rt.rate_id)] = 0;

  if (Object.keys(roomMap).length) {
    await wired(bcom ? "bcom_set_room_mapping" : "exp_set_room_mapping", lcode, chid, roomMap);
  }
  if (Object.keys(rateMap).length) {
    await wired(bcom ? "bcom_set_rate_mapping" : "exp_set_rate_mapping", lcode, chid, rateMap);
  }
  await importProperty(property.workspaceId, String(lcode), { name: property.name });
  return { rooms: Object.keys(roomMap).length, rates: Object.keys(rateMap).length };
}

/**
 * Background step: for every site waiting on the OTA's approval, check whether
 * it has been approved; if so, finish the mapping. Safe to run repeatedly.
 */
async function advanceOnboarding() {
  if (!isConfigured()) return { ok: false, reason: "not_configured" };
  const props = await Property.find({ "channel.wubookOnboarding.state": { $in: ["awaiting_approval", "mapping"] } });
  let advanced = 0;
  for (const p of props) {
    for (const entry of p.channel.wubookOnboarding.filter((o) => ["awaiting_approval", "mapping"].includes(o.state))) {
      try {
        if (entry.state === "awaiting_approval" && entry.ota === "booking_com") {
          try {
            await wired("bcom_confirm_activation", Number(p.channel.wubookLcode), Number(entry.chid));
          } catch (err) {
            // Not approved yet on Booking.com's side — keep waiting.
            if (Date.now() - new Date(entry.updatedAt || 0).getTime() > 7 * 24 * 3600 * 1000) {
              await setOnboarding(p._id, entry.ota, {
                state: "awaiting_approval",
                message: "Still waiting for your approval on Booking.com. " + APPROVAL_STEPS.booking_com,
              });
            }
            continue;
          }
        }
        await setOnboarding(p._id, entry.ota, { state: "mapping", message: "Approved — importing your rooms and rates…" });
        const fresh = await Property.findById(p._id);
        const r = await completeMapping(fresh, entry);
        await setOnboarding(p._id, entry.ota, {
          state: "live",
          message: `Live — ${r.rooms} room type${r.rooms === 1 ? "" : "s"} synced. Guests on this site are now answered by your AI.`,
        });
        advanced++;
        logger.info(`[WuBook] ${entry.ota} live lcode=${p.channel.wubookLcode} rooms=${r.rooms}`);
        require("../notificationService").notify(p.workspaceId, {
          type: "channel.live",
          title: `${require("../notificationService").channelLabel(entry.ota)} is live`,
          body: `${r.rooms} room type${r.rooms === 1 ? "" : "s"} synced. Guests there are now answered by your AI.`,
          link: "/dashboard/settings?tab=channels",
          channel: entry.ota,
        });
      } catch (err) {
        const pending = /not.*(active|approved|confirm)|pending|waiting/i.test(err.message);
        if (pending) continue; // Expedia not approved yet
        logger.warn(`[WuBook] onboarding ${entry.ota} failed lcode=${p.channel.wubookLcode}: ${err.message}`);
        require("../notificationService").notify(p.workspaceId, {
          type: "channel.error",
          title: `${require("../notificationService").channelLabel(entry.ota)} needs attention`,
          body: "We couldn't finish connecting this site automatically — our team is on it.",
          link: "/dashboard/settings?tab=channels",
          channel: entry.ota,
          priority: "high",
        });
        await setOnboarding(p._id, entry.ota, {
          state: "error",
          message: "We couldn't finish connecting this site automatically — our team has been notified and will fix it.",
          error: err.message.slice(0, 300),
        });
      }
    }
  }
  return { ok: true, advanced };
}

module.exports = {
  startSiteConnection,
  advanceOnboarding,
  _completeMapping: completeMapping,
  _shortName: shortName,
  isConfigured,
  messagingConfigured,
  messaging,
  listChannels,
  listConnectedChannels,
  importProperty,
  pushAvailabilityRange,
  pushRateRange,
  handlePush,
  pollBookings,
  registerPush,
  verifyWebhookToken,
  classifyWebhook,
  sourceFromOta,
  // exported for tests
  _normaliseBooking: normaliseBooking,
  _normaliseThreadMessages: normaliseThreadMessages,
  _euDate: euDate,
  _parseEuDate: parseEuDate,
};
