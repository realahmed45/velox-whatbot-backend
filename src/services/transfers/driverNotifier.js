/**
 * How a driver hears that a job is waiting.
 *
 * Dispatch decides WHO to ask; this decides HOW they are told. Kept separate
 * because the delivery channel is the part most likely to change: today SMS or
 * email, tomorrow perhaps an approved WhatsApp template or a push notification.
 * The payload never changes — it is always a link to the driver's job page.
 *
 * Every path returns rather than throws. A driver we cannot reach must not
 * stall the rotation; dispatch simply times them out and moves to the next.
 */
const logger = require("../../utils/logger");

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER || "";

const smsConfigured = () => !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

/** True when any delivery channel is usable. */
const isConfigured = () => smsConfigured() || !!process.env.BREVO_API_KEY;

/** Short and unambiguous — it will be read on a phone, probably while driving. */
function messageFor({ driver, transfer, link }) {
  const when = transfer.pickupAt
    ? new Date(transfer.pickupAt).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }) + " UTC"
    : "soon";
  const who = driver.displayName || driver.name;
  return (
    `Hi ${who}, a pickup is available: ${transfer.guestName || "a guest"}, ` +
    `${transfer.passengers || 2} passenger(s), ${when}` +
    (transfer.flightNumber ? `, flight ${transfer.flightNumber}` : "") +
    `. Accept or decline: ${link}`
  );
}

async function sendSms(to, body) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  if (!res.ok) {
    throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return true;
}

/**
 * Tell one driver about one job. SMS first (it reaches a phone without an app),
 * email as a fallback when SMS isn't set up.
 */
async function send({ driver, transfer, link }) {
  const body = messageFor({ driver, transfer, link });

  if (smsConfigured() && driver.phone) {
    try {
      await sendSms(driver.phone, body);
      logger.info(`[driverNotifier] sms → ${driver._id}`);
      return { ok: true, via: "sms" };
    } catch (err) {
      logger.warn(`[driverNotifier] sms failed for ${driver._id}: ${err.message}`);
    }
  }

  if (driver.email && process.env.BREVO_API_KEY) {
    try {
      const { sendEmail } = require("../emailService");
      await sendEmail({
        to: driver.email,
        subject: "New pickup available",
        html: `<p>${body.replace(link, `<a href="${link}">${link}</a>`)}</p>`,
      });
      logger.info(`[driverNotifier] email → ${driver._id}`);
      return { ok: true, via: "email" };
    } catch (err) {
      logger.warn(
        `[driverNotifier] email failed for ${driver._id}: ${err.message}`,
      );
    }
  }

  // Nothing configured. The job page still works if the driver opens their
  // saved link, so this degrades rather than breaking.
  logger.warn(
    `[driverNotifier] no delivery channel for driver=${driver._id} — link only: ${link}`,
  );
  return { ok: false, via: "none" };
}

module.exports = { isConfigured, send, messageFor };
