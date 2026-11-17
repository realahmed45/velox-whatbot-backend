/**
 * emailRelayService — guest messaging for Expedia and Trip.com via their
 * email relays (the route both platforms use by default).
 *
 * How it works:
 *  - Every hotel gets its own inbound address on our inbound domain,
 *    e.g. villa-senja-x7k2@in.botlify.site, which it sets ONCE as the
 *    guest-message email in Expedia Partner Central / Trip.com eBooking.
 *  - A guest writes in the Expedia/Trip.com app → the platform emails it from a
 *    masked relay address → Brevo Inbound Parsing posts it to
 *    /api/email/inbound → we normalise it into the shared OTA message pipeline
 *    (otaMessageService.ingest) → the same AI answers.
 *  - The reply is emailed (Brevo transactional API) to the guest's relay
 *    address, from + reply-to the hotel's inbound address, so the platform shows
 *    it in the guest's app and the next guest reply comes straight back to us.
 *
 * Brevo inbound (developers.brevo.com/docs/inbound-parse-webhooks):
 *   MX  <domain>  10 inbound1.sendinblue.com.  /  20 inbound2.sendinblue.com.
 *   POST /v3/webhooks {type:"inbound", events:["inboundEmailProcessed"], url, domain}
 *   payload: { items: [{ From:{Name,Address}, To:[…], Recipients:[…], Subject,
 *              RawTextBody, ExtractedMarkdownMessage, MessageId, InReplyTo }] }
 * Other inbound providers (SendGrid/Mailgun/Postmark) are parsed too.
 *
 * Env:
 *   INBOUND_EMAIL_DOMAIN   e.g. in.botlify.site (verified in Brevo, MX → Brevo)
 *   INBOUND_EMAIL_TOKEN    secret in the inbound webhook URL (?token=…)
 *   BREVO_API_KEY          (already set) — sends the replies
 */
const axios = require("axios");
const crypto = require("crypto");
const logger = require("../../utils/logger");
const Property = require("../../models/Property");

const DOMAIN = () => String(process.env.INBOUND_EMAIL_DOMAIN || "").trim().toLowerCase();
const TOKEN = () => process.env.INBOUND_EMAIL_TOKEN || "";
const isConfigured = () => !!DOMAIN();
const verifyWebhookToken = (t) => !!TOKEN() && t === TOKEN();

const slugify = (s) =>
  String(s || "hotel")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "hotel";

/** The hotel's inbound address (created once, stable afterwards). */
async function addressFor(property) {
  if (!isConfigured()) return null;
  if (property.emailRelay?.token && property.emailRelay?.address?.endsWith(`@${DOMAIN()}`)) {
    return property.emailRelay.address;
  }
  const token = property.emailRelay?.token || crypto.randomBytes(3).toString("hex");
  const address = `${slugify(property.name)}-${token}@${DOMAIN()}`;
  await Property.updateOne({ _id: property._id }, { $set: { "emailRelay.token": token, "emailRelay.address": address } });
  return address;
}

/** Which OTA a relay address belongs to (null = not an OTA guest relay). */
function otaFromSender(addr = "") {
  const a = String(addr).toLowerCase();
  if (/expediapartnercentral|expedia\.com|expediagroup|hotels\.com|vrbo/.test(a)) return "expedia";
  if (/trip\.com|ctrip|tripcom/.test(a)) return "trip_com";
  if (/guest\.booking\.com|booking\.com/.test(a)) return "booking_com";
  if (/airbnb/.test(a)) return "airbnb";
  return null;
}

const mailbox = (m) => {
  if (!m) return { address: "", name: "" };
  if (typeof m === "string") {
    const match = m.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
    return match ? { name: match[1].trim(), address: match[2].trim().toLowerCase() } : { name: "", address: m.trim().toLowerCase() };
  }
  return { name: m.Name || m.name || "", address: String(m.Address || m.address || m.Email || m.email || "").toLowerCase() };
};

/** Strip quoted history, separators and OTA footers from a guest email. */
function cleanBody(text = "") {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    const l = line.trim();
    if (
      /^on .{4,120} wrote:$/i.test(l) ||
      /^-{2,}\s*original message/i.test(l) ||
      /^_{5,}$/.test(l) ||
      /^(from|sent|von|de):\s.+/i.test(l) && out.length > 0 ||
      /reply above this line|please do not reply below|##-.*-##/i.test(l)
    ) {
      break;
    }
    if (l.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

/** Inbound payload (Brevo / SendGrid / Mailgun / Postmark) → flat emails. */
function parseInbound(body = {}) {
  const items = Array.isArray(body.items) ? body.items : [body];
  return items
    .map((it) => {
      const from = mailbox(it.From || it.from || it.sender);
      const toRaw = [
        ...(Array.isArray(it.Recipients) ? it.Recipients : []),
        ...(Array.isArray(it.To) ? it.To : it.To ? [it.To] : []),
        ...(it.to ? String(it.to).split(",") : []),
        ...(it.recipient ? [it.recipient] : []),
        ...(it.ToFull || []),
      ];
      const to = [...new Set(toRaw.map((t) => mailbox(t).address).filter(Boolean))];
      const text =
        it.ExtractedMarkdownMessage ||
        it.StrippedTextReply ||
        it["stripped-text"] ||
        cleanBody(it.RawTextBody || it.TextBody || it.text || it["body-plain"] || "");
      return {
        from,
        to,
        subject: it.Subject || it.subject || "",
        text: cleanBody(text),
        messageId: it.MessageId || it.MessageID || it["Message-Id"] || it.messageId || crypto.createHash("sha1").update(`${from.address}|${it.Subject || it.subject}|${text}`).digest("hex"),
      };
    })
    .filter((m) => m.from.address && m.to.length);
}

/** Which hotel an inbound email is for: the token in the recipient address. */
async function propertyForRecipients(to = []) {
  for (const addr of to) {
    if (!addr.endsWith(`@${DOMAIN()}`)) continue;
    const local = addr.split("@")[0];
    const token = local.split("-").pop();
    if (!token) continue;
    const p = await Property.findOne({ "emailRelay.token": token });
    if (p) return p;
  }
  return null;
}

/** Normalised OTA messages ready for otaMessageService.ingest. */
async function toOtaMessages(body) {
  const out = [];
  for (const e of parseInbound(body)) {
    const ota = otaFromSender(e.from.address);
    if (!ota) {
      logger.info(`[EmailRelay] ignored non-OTA email from ${e.from.address}`);
      continue;
    }
    const property = await propertyForRecipients(e.to);
    if (!property) {
      logger.warn(`[EmailRelay] no hotel for recipients ${e.to.join(",")}`);
      continue;
    }
    if (!e.text) continue;
    out.push({
      provider: "email",
      ota,
      threadId: e.from.address, // the guest's relay address = the thread
      bookingRef: e.from.address, // matched against the booking's guest email
      providerPropertyId: String(property._id),
      guestName: e.from.name.replace(/\s*\(?via (expedia|trip\.com)\)?/i, "").trim(),
      messageId: e.messageId,
      text: e.text,
      attachments: [],
      sender: "guest",
      at: new Date().toISOString(),
      subject: e.subject,
    });
  }
  return out;
}

// ── Messaging driver (plugged into otaMessageService) ────────────────────────

const messaging = {
  isAvailable: () => isConfigured() && !!process.env.BREVO_API_KEY,
  async pollNew() {
    return []; // inbound is push-only (webhook)
  },
  async fetchThread() {
    return [];
  },
  /** Email the reply to the guest's relay address, from the hotel's address. */
  async send({ threadId, text, conversation }) {
    const to = String(threadId || "");
    if (!to.includes("@")) return { success: false, error: "No relay email for this guest." };
    const propertyId = conversation?.metadata?.ota?.providerPropertyId || conversation?.metadata?.ota?.propertyId;
    const property = propertyId ? await Property.findById(propertyId).lean() : null;
    const from = property ? await addressFor(property) : null;
    if (!from) return { success: false, error: "Hotel email relay isn't set up." };
    const subj = conversation?.metadata?.ota?.emailSubject;
    const subject = subj
      ? `Re: ${String(subj).replace(/^re:\s*/i, "")}`
      : `Your stay at ${property.name}`;
    try {
      const { data } = await axios.post(
        "https://api.brevo.com/v3/smtp/email",
        {
          sender: { name: property.name, email: from },
          to: [{ email: to }],
          replyTo: { email: from, name: property.name },
          subject,
          textContent: String(text || ""),
        },
        { headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" }, timeout: 15000 },
      );
      return { success: true, messageId: data?.messageId || null };
    } catch (err) {
      const why = err.response?.data?.message || err.message;
      logger.warn(`[EmailRelay] send failed to ${to}: ${why}`);
      return { success: false, error: why };
    }
  },
};

module.exports = {
  isConfigured,
  verifyWebhookToken,
  addressFor,
  otaFromSender,
  cleanBody,
  parseInbound,
  toOtaMessages,
  messaging,
};
