/**
 * otaMessageService — guest messaging inside the booking sites.
 *
 * This is Botlify's core promise: a guest writes in their Airbnb, Booking.com
 * or Expedia inbox, and Botlify's AI answers them *in that same thread*.
 *
 * Flow:
 *   channel manager (Channex / Beds24 / Zodomus*)
 *     → driver.messaging.pollNew / fetchThread      normalised messages
 *     → ingest()                                     hotel, dedupe, history
 *     → automationEngine.handleWebhookEvent          the same AI brain, human
 *                                                    takeover rules and inbox
 *                                                    as WhatsApp
 *     → resolveSendTransport → send()                reply posted back into
 *                                                    the OTA thread
 *
 * Every driver returns the same normalised message:
 *   { provider, ota, threadId, bookingRef, providerPropertyId, guestName,
 *     messageId, text, attachments[], sender: guest|hotel|system, at }
 *
 * Idempotent: each message is stored once, keyed by metadata.externalId, so
 * polling with an overlapping window (and webhooks racing the poll) is safe.
 * (*Zodomus messaging switches on when their docs are confirmed.)
 */
const logger = require("../../utils/logger");
const Property = require("../../models/Property");
const HotelBooking = require("../../models/HotelBooking");
const Message = require("../../models/Message");
const Conversation = require("../../models/Conversation");

const OTA_CHANNELS = ["airbnb", "booking_com", "expedia"];
const isOtaChannel = (c) => OTA_CHANNELS.includes(c);

const DRIVERS = {
  channex: "../channels/channexService",
  beds24: "../channels/beds24Service",
  zodomus: "../channels/zodomusService",
  wubook: "../channels/wubookService",
};

function driver(name) {
  try {
    const svc = require(DRIVERS[name]);
    return svc.messaging && svc.messaging.isAvailable() ? svc.messaging : null;
  } catch {
    return null;
  }
}

/** Providers with live messaging AND at least one property connected through them. */
async function activeProviders() {
  const out = [];
  for (const name of Object.keys(DRIVERS)) {
    if (!driver(name)) continue;
    const has = await Property.exists({ "channel.provider": name });
    if (has) out.push(name);
  }
  return out;
}

/** The hotel a provider-side property id belongs to. */
async function findProperty(provider, providerPropertyId) {
  if (!providerPropertyId) return null;
  const id = String(providerPropertyId);
  if (provider === "channex") return Property.findOne({ "channel.channexPropertyId": id });
  if (provider === "beds24") return Property.findOne({ "channel.beds24PropertyId": id });
  if (provider === "wubook") return Property.findOne({ "channel.wubookLcode": id });
  if (provider === "zodomus") {
    return Property.findOne({ "channel.zodomus": { $elemMatch: { otaPropertyId: id } } });
  }
  return null;
}

/** The reservation behind a thread, so the AI knows who it's talking to. */
async function findBooking(property, msg) {
  if (!msg.bookingRef) return null;
  const ref = String(msg.bookingRef);
  return HotelBooking.findOne({
    propertyId: property._id,
    $or: [
      { otaReservationId: ref },
      { otaReservationId: `beds24:${ref}` },
      { otaReservationId: { $regex: `^${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(#|$)` } },
      { "otaRaw.id": ref },
      { "otaRaw.booking_id": ref },
      { otaReservationId: `wubook:${ref}` },
      { "otaRaw.reservation_code": Number.isFinite(Number(ref)) ? Number(ref) : ref },
      { "otaRaw.channel_reservation_code": ref },
    ],
  })
    .populate("roomTypeId", "name")
    .lean()
    .catch(() => null);
}

const day = (d) =>
  d ? new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";

/** Plain-language reservation facts for the AI's live context. */
function bookingContext(booking, ota) {
  if (!booking) {
    return `This guest is writing from the ${otaLabel(ota)} inbox. No reservation is linked yet (it may be an enquiry before booking).`;
  }
  const g = booking.guests || {};
  return [
    `This guest is writing from the ${otaLabel(ota)} inbox about their reservation:`,
    `- Booking: ${booking.code || booking.otaReservationId} (${booking.status})`,
    `- Guest: ${booking.guestName || "unknown"}`,
    `- Stay: ${day(booking.checkIn)} → ${day(booking.checkOut)} (${booking.nights} night${booking.nights === 1 ? "" : "s"})`,
    `- Room: ${booking.roomTypeId?.name || "room"}, ${g.adults ?? 2} adult(s)${g.children ? `, ${g.children} child(ren)` : ""}`,
    booking.totalAmount ? `- Total: ${booking.totalAmount} ${booking.currency}` : null,
    booking.specialRequests ? `- Special requests: ${booking.specialRequests}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const otaLabel = (ota) =>
  ({ airbnb: "Airbnb", booking_com: "Booking.com", expedia: "Expedia" })[ota] || "booking site";

/**
 * Store one normalised message and, for a new guest message, hand it to the AI.
 * Returns { ok, reason?, handled? }.
 */
async function ingest(msg) {
  if (!msg?.messageId || !isOtaChannel(msg.ota)) return { ok: false, reason: "unsupported" };
  const externalId = `${msg.provider}:${msg.messageId}`;

  const property = await findProperty(msg.provider, msg.providerPropertyId);
  if (!property) return { ok: false, reason: "unknown_property" };
  const workspaceId = property.workspaceId;

  if (await Message.exists({ workspaceId, "metadata.externalId": externalId })) {
    return { ok: true, reason: "duplicate" };
  }

  // Ignore anything we posted ourselves (it comes back on the next poll).
  if (msg.sender === "hotel") {
    const recent = await Message.exists({
      workspaceId,
      direction: "outbound",
      "metadata.otaThreadId": msg.threadId,
      text: msg.text,
      createdAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    if (recent) {
      // Tag our copy with the provider id so it's never re-imported.
      await Message.updateOne(
        { workspaceId, direction: "outbound", "metadata.otaThreadId": msg.threadId, text: msg.text },
        { $set: { "metadata.externalId": externalId } },
      ).catch(() => {});
      return { ok: true, reason: "own_echo" };
    }
  }

  const booking = await findBooking(property, msg);
  const senderId = `${msg.provider}:${msg.threadId}`;
  const ota = {
    provider: msg.provider,
    threadId: msg.threadId,
    bookingRef: msg.bookingRef || null,
    providerPropertyId: String(msg.providerPropertyId),
    propertyId: String(property._id),
    bookingId: booking?._id ? String(booking._id) : null,
  };

  // Staff replies typed directly in the OTA extranet, and system notices:
  // keep them in the conversation history, never answer them.
  if (msg.sender !== "guest") {
    const { upsertContactForOta, getOrCreateConversation } = require("../instagram/automationEngine")._ota;
    const Workspace = require("../../models/Workspace");
    const ws = await Workspace.findById(workspaceId);
    if (!ws) return { ok: false, reason: "no_workspace" };
    const contact = await upsertContactForOta(workspaceId, senderId, msg);
    const conv = await getOrCreateConversation(ws, contact, msg.ota);
    await Message.create({
      workspaceId,
      conversationId: conv._id,
      contactId: contact._id,
      direction: "outbound",
      sender: msg.sender === "hotel" ? "agent" : "system",
      type: "text",
      text: msg.text || "",
      channelType: msg.ota,
      status: "sent",
      metadata: { externalId, otaThreadId: msg.threadId, source: "ota_extranet" },
    });
    return { ok: true, reason: "history" };
  }

  const { handleWebhookEvent, TRIGGERS } = require("../instagram/automationEngine");
  await handleWebhookEvent(workspaceId, {
    type: TRIGGERS.DIRECT_MESSAGE,
    channel: msg.ota,
    senderId,
    senderName: msg.guestName || booking?.guestName || "",
    providerConversationId: msg.threadId,
    text: msg.text,
    incomingImageUrl: (msg.attachments || []).find((a) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(String(a))) || null,
    ota,
    externalId,
    otaContext: bookingContext(booking, msg.ota),
  });
  return { ok: true, handled: true };
}

/** Post a reply into the OTA thread behind a conversation. */
async function send(conversation, text) {
  const ota = conversation?.metadata?.ota;
  if (!ota?.provider) {
    return { success: false, error: "This conversation isn't linked to a booking-site thread." };
  }
  const d = driver(ota.provider);
  if (!d) return { success: false, error: `Messaging via ${ota.provider} isn't available.` };
  return d.send({ threadId: ota.threadId, bookingRef: ota.bookingRef, text });
}

// ── Polling ──────────────────────────────────────────────────────────────────
// Overlapping window: every run looks back further than the cadence, and
// ingest() dedupes, so a slow run or short outage never drops a message.
const LOOKBACK_MS = 15 * 60 * 1000;
let lastRun = Date.now() - LOOKBACK_MS;
let running = false;

async function poll() {
  if (running) return { ok: false, reason: "already_running" };
  running = true;
  const started = Date.now();
  const since = new Date(Math.min(lastRun, started) - LOOKBACK_MS);
  const totals = { scanned: 0, handled: 0, errors: 0 };
  try {
    for (const name of await activeProviders()) {
      try {
        const msgs = await driver(name).pollNew({ since });
        msgs.sort((a, b) => new Date(a.at) - new Date(b.at));
        for (const m of msgs) {
          totals.scanned++;
          try {
            const r = await ingest(m);
            if (r.handled) totals.handled++;
          } catch (err) {
            totals.errors++;
            logger.warn("[otaMessages] ingest failed", { provider: name, err: err.message });
          }
        }
      } catch (err) {
        totals.errors++;
        logger.warn(`[otaMessages] ${name} poll failed: ${err.message}`);
      }
    }
    lastRun = started;
    if (totals.handled) logger.info(`[otaMessages] ${totals.handled} new guest message(s) answered`);
    return { ok: true, ...totals };
  } finally {
    running = false;
  }
}

/** Webhook fast path: re-read one thread now instead of waiting for the poll. */
async function syncThread(provider, threadId) {
  const d = driver(provider);
  if (!d || !threadId) return { ok: false };
  const msgs = await d.fetchThread(threadId);
  let handled = 0;
  for (const m of msgs) {
    const r = await ingest(m).catch(() => ({}));
    if (r.handled) handled++;
  }
  return { ok: true, handled };
}

module.exports = {
  OTA_CHANNELS,
  isOtaChannel,
  ingest,
  send,
  poll,
  syncThread,
  bookingContext,
  _activeProviders: activeProviders,
};
