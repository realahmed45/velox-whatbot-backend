/**
 * transferService — arrange an airport pickup/drop-off for a guest.
 *
 * Decision tree (per property settings, see Property.transfers):
 *   1. Hotel runs its own service  → record it confirmed at their flat price.
 *   2. Partner service enabled + Mozio configured → search & book via Mozio;
 *      Botlify keeps MOZIO_MARGIN_RATE (default 8%) as transfer_margin revenue.
 *      Mozio failure still records a pending transfer so the hotel can step in.
 *   3. Neither → pending "hotel to arrange" record.
 *
 * Mirrors bookingService: persist first, then best-effort side effects
 * (socket, email, outbound webhooks) that never fail the transfer itself.
 */
const logger = require("../../utils/logger");
const TransferBooking = require("../../models/TransferBooking");
const mozioService = require("./mozioService");

/** Human label, e.g. "Fri, 12 Sep 14:30" in the workspace's timezone. */
function whenLabel(date, timezone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone || "UTC",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** One-line address for the property (Mozio geocodes free text). */
function propertyAddress(property) {
  return [property.name, property.address, property.city, property.country]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Create a transfer booking for a guest.
 *
 * @param {object} p
 * @param {object} p.workspace     Workspace doc
 * @param {object} p.transfer      {direction, pickupAt, flightNumber, guestName,
 *                                  guestPhone, passengers}
 * @param {object} [p.contact]     Contact doc (name/phone fallbacks)
 * @param {object} [p.conversation] Conversation doc (linkage)
 * @param {object} [p.property]    Property doc; defaults to first active one
 * @returns {Promise<{ok:boolean, transfer?:object, confirmationText?:string, reason?:string}>}
 */
async function createTransfer({
  workspace,
  transfer,
  contact = null,
  conversation = null,
  property = null,
}) {
  const direction =
    transfer?.direction === "dropoff" ? "dropoff" : "pickup";
  const pickupAt = new Date(transfer?.pickupAt);
  if (!transfer?.pickupAt || isNaN(pickupAt.getTime())) {
    return { ok: false, reason: "invalid_pickup_time" };
  }

  // Resolve the property (lazy require avoids model load cycles).
  if (!property) {
    const Property = require("../../models/Property");
    property = await Property.findOne({
      workspaceId: workspace._id,
      active: true,
    }).sort({ createdAt: 1 });
  }
  if (!property) return { ok: false, reason: "no_property" };

  const settings = property.transfers || {};
  const airportCode = settings.airportCode || "";
  const guestName = transfer.guestName || contact?.name || "";
  const guestPhone = transfer.guestPhone || contact?.phone || "";
  const passengers = Math.max(1, Number(transfer.passengers) || 2);

  const base = {
    workspaceId: workspace._id,
    propertyId: property._id,
    contactId: contact?._id,
    conversationId: conversation?._id,
    direction,
    guestName,
    guestPhone,
    passengers,
    flightNumber: transfer.flightNumber || "",
    pickupAt,
    airportCode,
  };

  let doc;

  // Is there a driver roster to dispatch to? The hotel's own if they run a
  // service, otherwise Botlify's shared pool. Checked before the branch below
  // so "hotel has its own service" and "hotel has drivers entered" stay
  // separate facts — a hotel can say yes at onboarding and add drivers later.
  const Driver = require("../../models/Driver");
  const driverPool = settings.hasOwnService
    ? { scope: "hotel", workspaceId: workspace._id }
    : { scope: "platform" };
  const driversAvailable = await Driver.countDocuments({
    ...driverPool,
    active: true,
  });

  if (settings.hasOwnService) {
    // ── 1. Hotel's own driver — confirmed at their flat price ──────────────
    doc = await TransferBooking.create({
      ...base,
      provider: "own",
      price: Number(settings.ownServicePrice) || 0,
      currency: property.currency || "USD",
      status: "confirmed",
      notes: settings.ownServiceNotes || "",
      dispatch: { state: driversAvailable ? "searching" : "idle" },
    });
  } else if (driversAvailable) {
    // ── 1b. No service of their own, but we have drivers — dispatch ours ───
    doc = await TransferBooking.create({
      ...base,
      provider: "platform",
      currency: property.currency || "USD",
      status: "pending",
      dispatch: { state: "searching" },
    });
  } else if (settings.offerPartnerService && mozioService.isConfigured()) {
    // ── 2. Partner (Mozio) transfer on the hotel's behalf ──────────────────
    doc = await bookViaMozio({
      base,
      property,
      airportCode,
      direction,
      pickupAt,
      passengers,
      guestName,
      guestPhone,
      contact,
      flightNumber: transfer.flightNumber || "",
      workspace,
    });
  } else {
    // ── 3. Nothing automated — the hotel arranges it manually ──────────────
    doc = await TransferBooking.create({
      ...base,
      provider: "own",
      status: "pending",
      currency: property.currency || "USD",
      notes: "hotel to arrange",
    });
  }

  // Start the driver rotation. Best-effort: a dispatch failure must not lose
  // the transfer record itself — the hotel can still arrange it by hand, and
  // the sweep job retries anything left searching.
  if (doc.dispatch?.state === "searching") {
    try {
      const dispatchService = require("./dispatchService");
      await dispatchService.offerNext(doc._id);
      doc = await TransferBooking.findById(doc._id);
    } catch (err) {
      logger.warn(`[transfer] dispatch failed for ${doc._id}: ${err.message}`);
    }
  }

  await afterTransferChange(workspace, property, doc, "created");

  const label = whenLabel(pickupAt, workspace.timezone);
  const what = direction === "pickup" ? "airport pickup" : "airport drop-off";
  // What the guest is told. A driver who has already accepted is named with
  // their number so the guest can reach them directly; while we're still
  // finding someone we say exactly that rather than implying a car is booked.
  const dispatchState = doc.dispatch?.state;
  let confirmationText;
  if (dispatchState === "assigned" && doc.driverSnapshot?.phone) {
    const { guestHandoffText } = require("./dispatchService");
    confirmationText =
      `Your ${what} is set for ${label} ✈️ ` + guestHandoffText(doc);
  } else if (dispatchState === "searching") {
    confirmationText =
      `Your ${what} is booked for ${label} ✈️ — we're assigning your driver now ` +
      `and will send you their name and number shortly. 🚗`;
  } else if (doc.status === "confirmed") {
    confirmationText =
      `Your ${what} is arranged for ${label} ✈️` +
      (doc.price > 0 ? ` — ${doc.currency} ${doc.price}` : "") +
      (doc.flightNumber ? ` (flight ${doc.flightNumber})` : "");
  } else {
    confirmationText = `We've noted your ${what} request for ${label} — the hotel will confirm the details shortly. 🚗`;
  }

  logger.info(
    `[transfer] created ws=${workspace._id} provider=${doc.provider} status=${doc.status} dir=${direction}`,
  );
  return { ok: true, transfer: doc, confirmationText };
}

/** Try search + book on Mozio; ALWAYS returns a persisted TransferBooking. */
async function bookViaMozio({
  base,
  property,
  airportCode,
  direction,
  pickupAt,
  passengers,
  guestName,
  guestPhone,
  contact,
  flightNumber,
  workspace,
}) {
  const airport = airportCode ? `${airportCode} Airport` : "the airport";
  const hotelAddr = propertyAddress(property);
  const pickupAddress = direction === "pickup" ? airport : hotelAddr;
  const dropoffAddress = direction === "pickup" ? hotelAddr : airport;

  try {
    const search = await mozioService.searchTransfers({
      pickupAddress,
      dropoffAddress,
      pickupDatetime: pickupAt.toISOString(),
      passengers,
    });
    if (search.ok && search.cheapest) {
      const resultId =
        search.cheapest.result_id ?? search.cheapest.id ?? null;
      const booking = await mozioService.bookTransfer({
        searchId: search.searchId,
        resultId,
        guest: {
          name: guestName,
          phone: guestPhone,
          email: contact?.email || "",
        },
        flightNumber,
      });
      if (booking.ok) {
        const price = extractPriceSafe(search.cheapest);
        const currency = extractCurrencySafe(search.cheapest) || "USD";
        const marginRate = Number(process.env.MOZIO_MARGIN_RATE || 0.08);
        const margin = Math.round(price * marginRate * 100) / 100;

        const doc = await TransferBooking.create({
          ...base,
          provider: "mozio",
          mozioSearchId: String(search.searchId || ""),
          mozioReservationId: booking.reservationId || null,
          mozioConfirmationNumber: booking.confirmationNumber || null,
          price,
          currency,
          margin,
          status: "confirmed",
        });

        // Ledger: Botlify's partner margin (best-effort, never blocks).
        if (margin > 0) {
          try {
            const { recordRevenue } = require("../commissionService");
            await recordRevenue({
              workspaceId: workspace._id,
              type: "transfer_margin",
              amount: margin,
              currency,
              rate: marginRate,
              transferId: doc._id,
              reference:
                booking.confirmationNumber || booking.reservationId || "",
            });
          } catch (e) {
            logger.warn("[transfer] ledger failed", { err: e.message });
          }
        }
        return doc;
      }
      logger.warn("[transfer] mozio booking failed", { err: booking.error });
    } else {
      logger.warn("[transfer] mozio search failed", { err: search.error });
    }
  } catch (e) {
    // mozioService shouldn't throw, but stay defensive anyway.
    logger.warn("[transfer] mozio flow error", { err: e.message });
  }

  // Mozio failed — still record it so the hotel sees & arranges manually.
  return TransferBooking.create({
    ...base,
    provider: "mozio",
    status: "pending",
    currency: property.currency || "USD",
    notes: "auto-booking failed — arrange manually",
  });
}

const extractPriceSafe = (result) => {
  const tp = result?.total_price ?? result?.price ?? result?.amount;
  if (typeof tp === "number") return tp;
  if (typeof tp === "string" && Number.isFinite(Number(tp))) return Number(tp);
  const n = Number(
    tp?.total_price_value ?? tp?.value ?? tp?.amount ?? tp?.total ?? 0,
  );
  return Number.isFinite(n) ? n : 0;
};

const extractCurrencySafe = (result) => {
  const tp = result?.total_price ?? result?.price ?? {};
  return (
    tp?.total_price_currency ||
    tp?.currency ||
    tp?.currency_code ||
    result?.currency ||
    null
  );
};

/** Best-effort side effects: socket, email to the hotel, outbound webhooks. */
async function afterTransferChange(workspace, property, doc, event) {
  try {
    const { getIO } = require("../../socket");
    getIO()
      ?.to(`workspace:${workspace._id}`)
      .emit("transfer:changed", {
        transferId: String(doc._id),
        direction: doc.direction,
        provider: doc.provider,
        status: doc.status,
        pickupAt: doc.pickupAt,
        guestName: doc.guestName,
        event,
      });
  } catch {
    /* socket not ready */
  }

  try {
    const { dispatchEvent } = require("../webhookDispatcher");
    dispatchEvent(workspace._id, `transfer.${event}`, {
      transferId: String(doc._id),
      direction: doc.direction,
      provider: doc.provider,
      status: doc.status,
      pickupAt: doc.pickupAt,
      airportCode: doc.airportCode,
      guestName: doc.guestName,
      price: doc.price,
      currency: doc.currency,
    }).catch(() => {});
  } catch {
    /* dispatcher not ready */
  }

  if (event === "created") {
    try {
      await notifyHotel(workspace, property, doc);
    } catch (e) {
      logger.warn("[transfer] notify email failed", { err: e.message });
    }
  }
}

async function notifyHotel(workspace, property, doc) {
  const Workspace = require("../../models/Workspace");
  const ws = await Workspace.findById(workspace._id)
    .select("owner")
    .populate("owner", "email");
  const to = property.email || ws?.owner?.email;
  if (!to) return;
  const { sendEmail } = require("../emailService");
  const base = process.env.CLIENT_URL || "https://botlify.site";
  const label = whenLabel(doc.pickupAt, workspace.timezone);
  const what = doc.direction === "pickup" ? "Airport pickup" : "Airport drop-off";
  const needsAction = doc.status === "pending";
  await sendEmail({
    to,
    subject: `🚗 ${what} ${needsAction ? "request" : "booked"}: ${doc.guestName || "Guest"} — ${label}`,
    text:
      `${what} ${needsAction ? "requested — please arrange it" : "confirmed"}.\n\n` +
      `Guest: ${doc.guestName || "—"}${doc.guestPhone ? ` (${doc.guestPhone})` : ""}\n` +
      `When: ${label}\n` +
      `Passengers: ${doc.passengers}\n` +
      (doc.flightNumber ? `Flight: ${doc.flightNumber}\n` : "") +
      (doc.airportCode ? `Airport: ${doc.airportCode}\n` : "") +
      `Provider: ${doc.provider}${doc.mozioConfirmationNumber ? ` (conf ${doc.mozioConfirmationNumber})` : ""}\n` +
      (doc.price > 0 ? `Price: ${doc.currency} ${doc.price}\n` : "") +
      (doc.notes ? `Notes: ${doc.notes}\n` : "") +
      `\nManage: ${base}/dashboard/transfers`,
    html:
      `<h2>🚗 ${what} ${needsAction ? "request" : "booked"}</h2>` +
      `<table cellpadding="6" style="border-collapse:collapse">` +
      `<tr><td><b>Guest</b></td><td>${doc.guestName || "—"}${doc.guestPhone ? ` (${doc.guestPhone})` : ""}</td></tr>` +
      `<tr><td><b>When</b></td><td>${label}</td></tr>` +
      `<tr><td><b>Passengers</b></td><td>${doc.passengers}</td></tr>` +
      (doc.flightNumber ? `<tr><td><b>Flight</b></td><td>${doc.flightNumber}</td></tr>` : "") +
      `<tr><td><b>Provider</b></td><td>${doc.provider}</td></tr>` +
      (doc.price > 0 ? `<tr><td><b>Price</b></td><td>${doc.currency} ${doc.price}</td></tr>` : "") +
      (doc.notes ? `<tr><td><b>Notes</b></td><td>${doc.notes}</td></tr>` : "") +
      `</table>` +
      `<p><a href="${base}/dashboard/transfers">Manage transfers →</a></p>`,
  });
}

module.exports = { createTransfer };
