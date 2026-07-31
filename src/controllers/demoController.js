/**
 * demoController — public "Book a Demo" endpoint for the marketing site.
 * Persists the lead and emails the Botlify team so you can follow up fast.
 * No auth; rate-limited by a simple per-email dedupe window.
 */
const asyncHandler = require("express-async-handler");
const DemoRequest = require("../models/DemoRequest");
const logger = require("../utils/logger");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// @POST /api/demo — book a demo (public).
const bookDemo = asyncHandler(async (req, res) => {
  const {
    name = "",
    email = "",
    phone = "",
    business = "",
    preferredTime = "",
    message = "",
    source = "header",
  } = req.body || {};

  if (!EMAIL_RE.test(String(email).trim())) {
    res.status(400);
    throw new Error("Please enter a valid email so we can reach you.");
  }
  const cleanEmail = String(email).trim().toLowerCase();

  // Soft dedupe — one request per email per 10 minutes (accidental double-tap).
  const recent = await DemoRequest.findOne({
    email: cleanEmail,
    createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) },
  });
  if (recent) {
    return res.json({
      success: true,
      message: "You're on the list — we'll be in touch shortly!",
      deduped: true,
    });
  }

  const demo = await DemoRequest.create({
    name: String(name).slice(0, 120),
    email: cleanEmail,
    phone: String(phone).slice(0, 40),
    business: String(business).slice(0, 160),
    preferredTime: String(preferredTime).slice(0, 120),
    message: String(message).slice(0, 1000),
    source: String(source).slice(0, 40),
  });

  // Email the Botlify team (best-effort — never fail the booking on email error).
  try {
    const { sendEmail } = require("../services/emailService");
    const to =
      process.env.ADMIN_NOTIFY_EMAIL ||
      process.env.SUPPORT_EMAIL ||
      "realahmedali4@gmail.com";
    await sendEmail({
      to,
      subject: `🎥 New demo request: ${demo.name || demo.email}`,
      text:
        `New "Book a Demo" request from the website.\n\n` +
        `Name: ${demo.name || "—"}\n` +
        `Email: ${demo.email}\n` +
        `Phone: ${demo.phone || "—"}\n` +
        `Business: ${demo.business || "—"}\n` +
        `Preferred time: ${demo.preferredTime || "—"}\n` +
        (demo.message ? `Message: ${demo.message}\n` : "") +
        `Source: ${demo.source}\n`,
      html:
        `<h2>🎥 New demo request</h2>` +
        `<table cellpadding="6" style="border-collapse:collapse">` +
        `<tr><td><b>Name</b></td><td>${demo.name || "—"}</td></tr>` +
        `<tr><td><b>Email</b></td><td><a href="mailto:${demo.email}">${demo.email}</a></td></tr>` +
        `<tr><td><b>Phone</b></td><td>${demo.phone || "—"}</td></tr>` +
        `<tr><td><b>Business</b></td><td>${demo.business || "—"}</td></tr>` +
        `<tr><td><b>Preferred time</b></td><td>${demo.preferredTime || "—"}</td></tr>` +
        (demo.message ? `<tr><td><b>Message</b></td><td>${demo.message}</td></tr>` : "") +
        `<tr><td><b>Source</b></td><td>${demo.source}</td></tr>` +
        `</table>`,
    });
  } catch (e) {
    logger.warn("[demo] notify email failed", { err: e.message });
  }

  logger.info(`[demo] booked email=${demo.email} business=${demo.business || "—"}`);
  res.status(201).json({
    success: true,
    message: "Thanks! We'll reach out shortly to set up your demo. 🎉",
  });
});

module.exports = { bookDemo };
