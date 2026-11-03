/**
 * Driver assignment — a person picks the driver; the system does the rest.
 *
 * Drivers are contacted by hand. A hotel with its own drivers assigns one from
 * its dashboard; for a hotel using Botlify's drivers, the Botlify team assigns
 * one from /admin. The moment a driver is assigned, the guest is sent the
 * driver's name, car and WhatsApp number in the conversation they booked
 * through — that hand-off is the part worth automating, because it is the part
 * a busy front desk forgets.
 *
 * (An automatic rotation that texted drivers one by one existed before this.
 * SMS to Indonesia costs ~$0.44 a message, so it was removed in favour of
 * manual assignment.)
 */
const logger = require("../../utils/logger");
const Driver = require("../../models/Driver");
const TransferBooking = require("../../models/TransferBooking");

/**
 * Put a driver on a pickup and tell the guest.
 *
 * `scope` is who is assigning: "hotel" may only use its own drivers, "platform"
 * (the Botlify team) may only use Botlify's pool. A hotel must never be able to
 * hand its guest to a driver it doesn't know.
 *
 * Re-assigning is allowed (a driver drops out) and re-sends the guest the new
 * driver's details.
 */
async function assignDriver({ transferId, driverId, scope, workspaceId }) {
  const transfer = await TransferBooking.findById(transferId);
  if (!transfer) return { ok: false, reason: "not_found" };
  if (scope === "hotel" && String(transfer.workspaceId) !== String(workspaceId)) {
    return { ok: false, reason: "not_found" };
  }
  if (["cancelled", "completed"].includes(transfer.status)) {
    return { ok: false, reason: "closed" };
  }

  const driver = await Driver.findOne({
    _id: driverId,
    active: true,
    ...(scope === "hotel"
      ? { scope: "hotel", workspaceId: transfer.workspaceId }
      : { scope: "platform" }),
  });
  if (!driver) return { ok: false, reason: "driver_not_found" };

  transfer.driverId = driver._id;
  transfer.driverSnapshot = {
    name: driver.displayName,
    phone: driver.phone,
    vehicleLabel: driver.vehicleLabel,
  };
  transfer.dispatch = { ...(transfer.dispatch?.toObject?.() || {}), state: "assigned" };
  if (transfer.status === "pending") transfer.status = "confirmed";
  await transfer.save();

  await Driver.updateOne(
    { _id: driver._id },
    { $inc: { "stats.accepted": 1 }, $set: { "stats.lastAcceptedAt": new Date() } },
  );
  logger.info(`[transfer] driver ${driver._id} assigned to ${transfer._id} by ${scope}`);

  // Best-effort: a failed message must not undo the assignment — the driver
  // is booked either way, and the number is visible to whoever assigned it.
  let guestTold = false;
  try {
    guestTold = (await tellGuestTheirDriver(transfer)).ok;
  } catch (err) {
    logger.warn(`[transfer] could not tell guest about driver: ${err.message}`);
  }

  return { ok: true, transfer, driver, guestTold };
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

/** What the guest is told once a driver is assigned. */
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

module.exports = { assignDriver, tellGuestTheirDriver, guestHandoffText };
