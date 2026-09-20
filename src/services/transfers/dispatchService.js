/**
 * Driver dispatch — find a driver for an airport pickup, one at a time.
 *
 * The rule the hotel was promised: offer the job to the first driver, give them
 * ten minutes, and if they don't answer move to the next. Repeat until someone
 * accepts or we run out. Then the guest is told which driver is coming and how
 * to reach them.
 *
 * Why a link and not a WhatsApp message to the driver:
 * WhatsApp does not let a business open a conversation with a number that never
 * messaged it first — that needs a Meta-approved template per message type, a
 * per-message fee, and it fails outright if a driver blocks the number. Dispatch
 * is also the one place we need an unambiguous answer: a tap on "Accept" is a
 * fact, whereas parsing "ok boss" out of free text is a guess, and a wrong guess
 * costs a guest their airport pickup. So drivers get a private link, and
 * WhatsApp stays where it belongs — between the guest and the driver, after the
 * assignment, on the driver's own number.
 *
 * `notifyDriver` is deliberately pluggable. Today it logs the link and fires
 * whatever notifier is configured; swapping in SMS, push, or an approved
 * WhatsApp template later touches only that one function.
 */
const crypto = require("crypto");
const logger = require("../../utils/logger");
const Driver = require("../../models/Driver");
const TransferBooking = require("../../models/TransferBooking");

// How long a driver has to answer before the job moves on.
const OFFER_TIMEOUT_MINUTES = Number(process.env.DRIVER_OFFER_TIMEOUT_MIN || 10);

/** Random, unguessable, URL-safe. */
const newToken = () => crypto.randomBytes(24).toString("base64url");

/** The page a driver opens to accept or decline. */
function driverLink(token) {
  const base =
    process.env.CLIENT_URL ||
    process.env.API_PUBLIC_URL ||
    "https://botlify.site";
  return `${base.replace(/\/$/, "")}/drive/${token}`;
}

/**
 * Give a driver a dispatch token if they don't have one yet. Existing tokens
 * are left alone so a driver's saved link keeps working.
 */
async function ensureDispatchToken(driver) {
  if (driver.dispatchToken) return driver.dispatchToken;
  driver.dispatchToken = newToken();
  await driver.save();
  return driver.dispatchToken;
}

/** Invalidate a leaked link. The driver gets a new one; the old 404s. */
async function rotateDispatchToken(driver) {
  driver.dispatchToken = newToken();
  await driver.save();
  return driver.dispatchToken;
}

/**
 * Who can take this job, best first.
 *
 * A hotel with its own drivers only ever sees its own. A hotel without one
 * draws from Botlify's shared pool. Order is priority, then whoever has been
 * waiting longest for a job — so a flat default still spreads work instead of
 * hammering whichever driver happens to sort first.
 */
async function candidateDrivers({ workspaceId, useOwnDrivers, excludeIds = [] }) {
  const filter = {
    active: true,
    _id: { $nin: excludeIds },
    ...(useOwnDrivers
      ? { scope: "hotel", workspaceId }
      : { scope: "platform" }),
  };
  return Driver.find(filter)
    .sort({ priority: 1, "stats.lastOfferedAt": 1, createdAt: 1 })
    .limit(25);
}

/**
 * Notify one driver that a job is waiting.
 *
 * Returns { ok } rather than throwing: a driver we cannot reach must not stop
 * the rotation — the whole point is to move on to the next one.
 */
async function notifyDriver(driver, transfer, link) {
  try {
    const when = transfer.pickupAt
      ? new Date(transfer.pickupAt).toISOString()
      : "soon";
    logger.info(
      `[dispatch] offering transfer=${transfer._id} to driver=${driver._id} (${driver.name}) pickup=${when} link=${link}`,
    );

    // Pluggable delivery. Nothing is wired by default — the link is the
    // payload, and how it reaches the driver is a deployment choice.
    const notifier = require("./driverNotifier");
    if (notifier.isConfigured()) {
      await notifier.send({ driver, transfer, link });
    }
    return { ok: true };
  } catch (err) {
    logger.warn(
      `[dispatch] could not notify driver=${driver._id}: ${err.message}`,
    );
    return { ok: false, error: err.message };
  }
}

/**
 * Offer the job to the next untried driver.
 *
 * Idempotent by design: it only ever acts when there is no live offer, so a
 * retry, a double webhook or an overlapping sweep cannot double-book a trip.
 */
async function offerNext(transferId) {
  const transfer = await TransferBooking.findById(transferId);
  if (!transfer) return { ok: false, reason: "not_found" };
  if (transfer.dispatch?.state === "assigned") {
    return { ok: true, reason: "already_assigned" };
  }

  // Don't stack offers — one live offer at a time is the whole model.
  const live = (transfer.dispatch?.offers || []).find(
    (o) => o.outcome === "pending",
  );
  if (live) return { ok: true, reason: "offer_pending" };

  const property = await require("../../models/Property").findById(
    transfer.propertyId,
  );
  const useOwnDrivers = !!property?.transfers?.hasOwnService;

  const tried = (transfer.dispatch?.offers || []).map((o) => o.driverId);
  const candidates = await candidateDrivers({
    workspaceId: transfer.workspaceId,
    useOwnDrivers,
    excludeIds: tried,
  });

  if (!candidates.length) {
    transfer.dispatch.state = "exhausted";
    transfer.dispatch.lastError = tried.length
      ? "Every driver was asked and nobody accepted."
      : "No drivers are set up to take this job.";
    await transfer.save();
    logger.warn(
      `[dispatch] transfer=${transfer._id} exhausted after ${tried.length} offer(s)`,
    );
    await notifyHotelExhausted(transfer);
    return { ok: false, reason: "exhausted" };
  }

  const driver = candidates[0];
  const token = await ensureDispatchToken(driver);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OFFER_TIMEOUT_MINUTES * 60000);

  transfer.dispatch.state = "searching";
  transfer.dispatch.offers.push({
    driverId: driver._id,
    offeredAt: now,
    expiresAt,
    outcome: "pending",
  });
  await transfer.save();

  await Driver.updateOne(
    { _id: driver._id },
    { $inc: { "stats.offered": 1 }, $set: { "stats.lastOfferedAt": now } },
  );

  await notifyDriver(driver, transfer, driverLink(token));

  return { ok: true, driverId: driver._id, expiresAt };
}

/**
 * A driver tapped Accept.
 *
 * First acceptance wins. A second driver arriving late is told the job is gone
 * rather than silently overwriting the first — two drivers at the airport for
 * one guest is worse than none.
 */
async function acceptOffer({ transferId, driverId }) {
  const transfer = await TransferBooking.findById(transferId);
  if (!transfer) return { ok: false, reason: "not_found" };

  if (transfer.dispatch?.state === "assigned") {
    const mine = String(transfer.driverId) === String(driverId);
    return mine
      ? { ok: true, reason: "already_yours", transfer }
      : { ok: false, reason: "taken" };
  }

  const offer = (transfer.dispatch?.offers || []).find(
    (o) => String(o.driverId) === String(driverId) && o.outcome === "pending",
  );
  if (!offer) return { ok: false, reason: "no_open_offer" };

  const driver = await Driver.findById(driverId);
  if (!driver || !driver.active) return { ok: false, reason: "driver_inactive" };

  const now = new Date();
  offer.outcome = "accepted";
  offer.respondedAt = now;
  transfer.dispatch.state = "assigned";
  transfer.driverId = driver._id;
  transfer.driverSnapshot = {
    name: driver.displayName,
    phone: driver.phone,
    vehicleLabel: driver.vehicleLabel,
  };
  if (transfer.status === "pending") transfer.status = "confirmed";
  await transfer.save();

  await Driver.updateOne(
    { _id: driver._id },
    { $inc: { "stats.accepted": 1 }, $set: { "stats.lastAcceptedAt": now } },
  );

  logger.info(
    `[dispatch] transfer=${transfer._id} accepted by driver=${driver._id}`,
  );

  // Tell the guest who is coming. Best-effort: a failed message must not undo
  // the assignment — the driver is booked either way, and the hotel can pass
  // the number on by hand.
  try {
    await tellGuestTheirDriver(transfer);
  } catch (err) {
    logger.warn(
      `[dispatch] could not tell guest about driver for ${transfer._id}: ${err.message}`,
    );
  }

  return { ok: true, transfer, driver };
}

/**
 * Send the driver's name and number to the guest, in whatever conversation
 * they booked through.
 *
 * Only works when the transfer came from a chat we own. A transfer typed in by
 * the hotel has no conversation, so there is nobody to message — that is a
 * normal outcome, not an error.
 */
async function tellGuestTheirDriver(transfer) {
  if (!transfer.conversationId) return { ok: false, reason: "no_conversation" };

  const Conversation = require("../../models/Conversation");
  const Contact = require("../../models/Contact");
  const Workspace = require("../../models/Workspace");

  const [conversation, workspace] = await Promise.all([
    Conversation.findById(transfer.conversationId),
    Workspace.findById(transfer.workspaceId),
  ]);
  if (!conversation || !workspace) return { ok: false, reason: "missing" };

  const contact = await Contact.findById(conversation.contactId);
  if (!contact?.igUserId) return { ok: false, reason: "no_contact" };

  const { resolveSendTransport } = require("../instagram/automationEngine");
  const sendTransport = await resolveSendTransport(workspace, conversation);
  const result = await sendTransport.send(
    contact.igUserId,
    guestHandoffText(transfer),
    { conversationId: conversation.metadata?.providerConversationId },
  );
  return { ok: !!result?.success };
}

/** A driver tapped Decline — move straight on, don't wait out the clock. */
async function declineOffer({ transferId, driverId }) {
  const transfer = await TransferBooking.findById(transferId);
  if (!transfer) return { ok: false, reason: "not_found" };

  const offer = (transfer.dispatch?.offers || []).find(
    (o) => String(o.driverId) === String(driverId) && o.outcome === "pending",
  );
  if (!offer) return { ok: false, reason: "no_open_offer" };

  offer.outcome = "declined";
  offer.respondedAt = new Date();
  await transfer.save();
  await Driver.updateOne({ _id: driverId }, { $inc: { "stats.declined": 1 } });

  logger.info(
    `[dispatch] transfer=${transfer._id} declined by driver=${driverId} — moving on`,
  );
  return await offerNext(transfer._id);
}

/**
 * Time out offers nobody answered and pass the job along. Called on a timer.
 *
 * Each transfer is handled independently so one bad record cannot stall the
 * queue for everyone else.
 */
async function sweepExpiredOffers() {
  const now = new Date();
  const stuck = await TransferBooking.find({
    "dispatch.state": "searching",
    "dispatch.offers": {
      $elemMatch: { outcome: "pending", expiresAt: { $lte: now } },
    },
  }).limit(50);

  let moved = 0;
  for (const transfer of stuck) {
    try {
      let changed = false;
      for (const offer of transfer.dispatch.offers) {
        if (offer.outcome === "pending" && offer.expiresAt <= now) {
          offer.outcome = "timeout";
          offer.respondedAt = now;
          changed = true;
          await Driver.updateOne(
            { _id: offer.driverId },
            { $inc: { "stats.missed": 1 } },
          );
        }
      }
      if (!changed) continue;
      await transfer.save();
      await offerNext(transfer._id);
      moved++;
    } catch (err) {
      logger.warn(
        `[dispatch] sweep failed for transfer=${transfer._id}: ${err.message}`,
      );
    }
  }
  if (moved) logger.info(`[dispatch] sweep moved ${moved} transfer(s) along`);
  return { ok: true, moved };
}

/**
 * Nobody took the job. Tell the hotel rather than letting a guest turn up to
 * no car — a silent failure here is the worst outcome in the whole feature.
 */
async function notifyHotelExhausted(transfer) {
  try {
    const Workspace = require("../../models/Workspace");
    const ws = await Workspace.findById(transfer.workspaceId).select(
      "name ownerEmail",
    );
    const email = ws?.ownerEmail;
    if (!email) return;
    const { sendEmail } = require("../emailService");
    const when = new Date(transfer.pickupAt).toUTCString();
    await sendEmail({
      to: email,
      subject: "Airport pickup needs a driver",
      html:
        `<p>No driver accepted the pickup for <b>${transfer.guestName || "your guest"}</b> ` +
        `at ${when}.</p><p>Please arrange this one by hand — the guest has not been given a driver.</p>`,
    });
  } catch (err) {
    logger.warn(`[dispatch] exhausted-notice failed: ${err.message}`);
  }
}

/** What the guest is told once a driver is locked in. */
function guestHandoffText(transfer) {
  const d = transfer.driverSnapshot || {};
  if (!d.phone) return "";
  const bits = [
    `Your driver is ${d.name}.`,
    d.vehicleLabel ? `They'll be in a ${d.vehicleLabel}.` : "",
    `You can reach them on WhatsApp at ${d.phone}.`,
  ].filter(Boolean);
  return bits.join(" ");
}

module.exports = {
  OFFER_TIMEOUT_MINUTES,
  tellGuestTheirDriver,
  offerNext,
  acceptOffer,
  declineOffer,
  sweepExpiredOffers,
  candidateDrivers,
  ensureDispatchToken,
  rotateDispatchToken,
  driverLink,
  guestHandoffText,
};
