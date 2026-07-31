/**
 * booking.js — persist a bot-captured appointment and fire the dual
 * confirmation (customer + business). Mirrors the Smart Orders save path.
 *
 * The AI emits <<BOOK_APPOINTMENT_JSON>>{...}<<END_BOOK>> once it has collected
 * everything. automationEngine parses it (via services/ai) and calls
 * `saveBooking` here. The friendly confirmation line to the CUSTOMER is written
 * by the model itself (above the marker) and delivered as the DM reply — so we
 * only need to notify the BUSINESS here, plus persist + emit events.
 *
 * @returns {Promise<{ ok, appointment?, reason?, confirmationText? }>}
 */
const logger = require("../../utils/logger");
const { isSlotAvailable } = require("./slotEngine");

/**
 * Parse the ISO/loose datetime the model emitted into a Date.
 * The prompt instructs the model to emit an ISO-8601 string in the business
 * timezone with offset; we accept a bare ISO too.
 */
function parseWhen(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Short human label for a booking, in the workspace timezone. */
function bookingLabel(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "Asia/Karachi",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Persist a booking captured by the AI and notify the business.
 *
 * @param {object} workspace  full workspace doc
 * @param {object} contact    the Contact doc
 * @param {object} conv       the Conversation doc
 * @param {object} booking    parsed { service, startAt, customerName, customerPhone, notes }
 */
async function saveBooking(workspace, contact, conv, booking) {
  const Appointment = require("../../models/Appointment");
  const tz = workspace.timezone || "Asia/Karachi";

  const start = parseWhen(booking.startAt);
  if (!start) return { ok: false, reason: "invalid_time" };

  // Re-validate against live availability — the model may have offered a slot
  // that got taken mid-conversation, or hallucinated a time.
  const check = await isSlotAvailable(workspace, start, booking.service);
  if (!check.ok) {
    logger.info(
      `[booking] rejected ws=${workspace._id} reason=${check.reason} at=${start.toISOString()}`,
    );
    return { ok: false, reason: check.reason };
  }

  const cfg = workspace.appointments || {};
  const status = cfg.requireApproval ? "pending" : "confirmed";
  const duration = check.durationMinutes || 30;

  const appt = await Appointment.create({
    workspaceId: workspace._id,
    contactId: contact?._id,
    conversationId: conv?._id,
    igUsername: contact?.igUsername || "",
    customerName: booking.customerName || contact?.name || "",
    customerPhone: booking.customerPhone || contact?.phone || "",
    customerEmail: booking.customerEmail || contact?.email || "",
    service: check.service || booking.service || "",
    durationMinutes: duration,
    startAt: start,
    endAt: check.endAt,
    notes: booking.notes || "",
    status,
    source: "bot",
  });

  // Tag the contact so the merchant sees the booking on the profile.
  try {
    if (contact && !(contact.tags || []).includes("appointment")) {
      contact.tags = [...(contact.tags || []), "appointment"];
      await contact.save();
    }
  } catch {
    /* non-fatal */
  }

  // Realtime → dashboard lights up.
  try {
    const { getIO } = require("../../socket");
    getIO()
      ?.to(`workspace:${workspace._id}`)
      .emit("appointment:created", {
        appointmentId: String(appt._id),
        customerName: appt.customerName,
        service: appt.service,
        startAt: appt.startAt,
        status: appt.status,
      });
  } catch {
    /* socket not ready */
  }

  // Webhook event for integrators.
  try {
    const { dispatchEvent } = require("../webhookDispatcher");
    dispatchEvent(workspace._id, "appointment.created", {
      appointmentId: String(appt._id),
      contactId: String(contact?._id || ""),
      customerName: appt.customerName,
      service: appt.service,
      startAt: appt.startAt,
      status: appt.status,
    }).catch(() => {});
  } catch {
    /* dispatcher not ready */
  }

  // Email the business (owner or configured notifyEmail).
  await notifyBusiness(workspace, appt, tz).catch((e) =>
    logger.warn("[booking] business notify failed", { err: e.message }),
  );

  logger.info(
    `[booking] saved ws=${workspace._id} appt=${appt._id} status=${status} at=${start.toISOString()}`,
  );

  // A short, reliable confirmation line the caller can append to the DM in case
  // the model didn't write one itself.
  const loc = cfg.locationName || cfg.locationAddress;
  const confirmationText =
    status === "pending"
      ? `Got it! I've requested your ${appt.service || "appointment"} for ${bookingLabel(start, tz)}. We'll confirm shortly. ✅`
      : `You're booked! ✅ ${appt.service || "Appointment"} — ${bookingLabel(start, tz)}${loc ? `\n📍 ${loc}` : ""}${cfg.mapsUrl ? `\n${cfg.mapsUrl}` : ""}`;

  return { ok: true, appointment: appt, confirmationText };
}

/** Email the business about a new booking (best-effort, throttle-free). */
async function notifyBusiness(workspace, appt, tz) {
  const Workspace = require("../../models/Workspace");
  const cfg = workspace.appointments || {};
  let to = cfg.notifyEmail;
  if (!to) {
    const ws = await Workspace.findById(workspace._id)
      .select("owner")
      .populate("owner", "email");
    to = ws?.owner?.email;
  }
  if (!to) return;

  const when = bookingLabel(appt.startAt, tz);
  const { sendEmail } = require("../emailService");
  const base = process.env.CLIENT_URL || "https://botlify.site";
  const statusLine =
    appt.status === "pending"
      ? "⏳ Needs your approval"
      : "✅ Confirmed";
  await sendEmail({
    to,
    subject: `📅 New appointment: ${appt.customerName || "Customer"} — ${when}`,
    text:
      `New appointment booked via Instagram DM.\n\n` +
      `Status: ${statusLine}\n` +
      `Service: ${appt.service || "—"}\n` +
      `When: ${when}\n` +
      `Customer: ${appt.customerName || "—"}${appt.customerPhone ? ` (${appt.customerPhone})` : ""}\n` +
      (appt.igUsername ? `Instagram: @${appt.igUsername}\n` : "") +
      (appt.notes ? `Notes: ${appt.notes}\n` : "") +
      `\nManage it here: ${base}/dashboard/appointments`,
    html:
      `<h2>📅 New appointment</h2>` +
      `<p><b>${statusLine}</b></p>` +
      `<table cellpadding="6" style="border-collapse:collapse">` +
      `<tr><td><b>Service</b></td><td>${appt.service || "—"}</td></tr>` +
      `<tr><td><b>When</b></td><td>${when}</td></tr>` +
      `<tr><td><b>Customer</b></td><td>${appt.customerName || "—"}${appt.customerPhone ? ` (${appt.customerPhone})` : ""}</td></tr>` +
      (appt.igUsername ? `<tr><td><b>Instagram</b></td><td>@${appt.igUsername}</td></tr>` : "") +
      (appt.notes ? `<tr><td><b>Notes</b></td><td>${appt.notes}</td></tr>` : "") +
      `</table>` +
      `<p><a href="${base}/dashboard/appointments">Manage appointments →</a></p>`,
  });
  appt.businessNotifiedAt = new Date();
  await appt.save().catch(() => {});
}

module.exports = { saveBooking, bookingLabel };
