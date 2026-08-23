/**
 * readiness.js — one loud, honest report at boot about what is and isn't
 * configured.
 *
 * The failure mode this exists to prevent: a hotel is onboarded, everything
 * *looks* fine, and weeks later someone notices OTA bookings never arrived
 * because a key was missing or pointed at staging. Silent misconfiguration is
 * the expensive kind, so we say it plainly at startup.
 *
 * Never throws and never exits — a missing optional integration must not stop
 * the server. Only genuinely fatal gaps (no database, no auth secret) are
 * flagged as CRITICAL, and those already fail elsewhere.
 */
const logger = require("./logger");

const isSet = (v) => !!(v && String(v).trim() && !String(v).startsWith("your_"));

function checkReadiness() {
  const env = process.env;
  const prod = env.NODE_ENV === "production";
  const critical = [];
  const warnings = [];
  const ready = [];

  // ── Core (the app cannot work without these) ─────────────────────────────
  if (!isSet(env.MONGODB_URI)) critical.push("MONGODB_URI — no database");
  else ready.push("database");

  if (!isSet(env.JWT_SECRET)) critical.push("JWT_SECRET — logins will fail");
  if (!isSet(env.AES_SECRET_KEY)) {
    critical.push("AES_SECRET_KEY — channel tokens cannot be encrypted");
  }

  // ── AI (the product's core value) ────────────────────────────────────────
  if (!isSet(env.GEMINI_API_KEY)) {
    critical.push("GEMINI_API_KEY — the AI concierge and agent will not reply");
  } else ready.push("AI (Gemini)");

  // ── Messaging channels ───────────────────────────────────────────────────
  if (!isSet(env.BOTLIFY_IG_PROVIDER_API_KEY)) {
    warnings.push(
      "BOTLIFY_IG_PROVIDER_API_KEY — WhatsApp/Instagram/TikTok cannot connect",
    );
  } else ready.push("messaging channels");

  // ── OTA sync ─────────────────────────────────────────────────────────────
  if (!isSet(env.CHANNEX_API_KEY)) {
    warnings.push(
      "CHANNEX_API_KEY — Booking.com/Airbnb sync is OFF (hotels add rooms manually)",
    );
  } else {
    const base = env.CHANNEX_BASE_URL || "";
    if (prod && /staging/.test(base)) {
      critical.push(
        "CHANNEX_BASE_URL points at STAGING in production — real OTA bookings will NOT arrive",
      );
    } else if (prod && !isSet(base)) {
      warnings.push(
        "CHANNEX_BASE_URL not set — defaulting to production API (app.channex.io)",
      );
      ready.push("OTA sync");
    } else {
      ready.push("OTA sync" + (/staging/.test(base) ? " (staging)" : ""));
    }
    if (!isSet(env.CHANNEX_WEBHOOK_TOKEN)) {
      critical.push(
        "CHANNEX_WEBHOOK_TOKEN missing — inbound OTA reservations will be REJECTED",
      );
    }
  }

  // ── Billing ──────────────────────────────────────────────────────────────
  if (!isSet(env.CREEM_API_KEY)) {
    warnings.push("CREEM_API_KEY — the paid plan cannot be purchased (free plan works)");
  } else {
    if (!isSet(env.CREEM_WEBHOOK_SECRET)) {
      critical.push(
        "CREEM_WEBHOOK_SECRET missing — payments will not activate subscriptions",
      );
    }
    if (!isSet(env.CREEM_PRODUCT_HOTEL_PRO_MONTHLY)) {
      warnings.push(
        "CREEM_PRODUCT_HOTEL_PRO_MONTHLY — the $49 monthly plan has no product to check out",
      );
    } else ready.push("billing");
  }

  // ── Supporting services ──────────────────────────────────────────────────
  if (!isSet(env.BREVO_API_KEY)) {
    warnings.push("BREVO_API_KEY — no emails (confirmations, invoices, invites)");
  } else ready.push("email");

  if (!isSet(env.CLOUDINARY_CLOUD_NAME)) {
    warnings.push("CLOUDINARY_CLOUD_NAME — photo uploads will fail");
  } else ready.push("media uploads");

  if (!isSet(env.MOZIO_API_KEY)) {
    warnings.push(
      "MOZIO_API_KEY — transfers are recorded as 'arrange manually' (not auto-booked)",
    );
  } else ready.push("transfers");

  if (prod && !isSet(env.SENTRY_DSN)) {
    warnings.push("SENTRY_DSN — production errors are only in local logs");
  }

  if (!isSet(env.API_PUBLIC_URL)) {
    critical.push(
      "API_PUBLIC_URL — webhook callback URLs will be wrong, channels and OTA sync will break",
    );
  }

  // ── Report ───────────────────────────────────────────────────────────────
  logger.info("[readiness] ready: " + (ready.join(", ") || "nothing"));
  warnings.forEach((w) => logger.warn("[readiness] " + w));
  critical.forEach((c) => logger.error("[readiness] CRITICAL: " + c));

  if (critical.length) {
    logger.error(
      "[readiness] " +
        critical.length +
        " critical issue(s) — the app is running but part of it will not work.",
    );
  } else if (!warnings.length) {
    logger.info("[readiness] everything is configured.");
  }

  return { critical, warnings, ready };
}

module.exports = { checkReadiness };
