/**
 * guestService — one person, however many channels they arrived through.
 *
 * A guest who booked on Booking.com in March, DM'd on Instagram in June and
 * WhatsApp'd about a transfer in July is three records everywhere else. Here
 * they collapse into one Guest, matched on:
 *      normalized phone → email → (exact name + workspace)
 *
 * Stats are never incremented in place — they're recomputed from that guest's
 * bookings every time, so a re-run is always safe (the sync job re-processes
 * the same bookings on every pass by design).
 */
const Guest = require("../../models/Guest");
const HotelBooking = require("../../models/HotelBooking");
const logger = require("../../utils/logger");

// Channels where the guest messaged US — the only ToS-safe basis for direct
// rebounding. OTA contact details never count.
const FIRST_PARTY_CHANNELS = ["whatsapp", "instagram", "tiktok", "direct"];
const OTA_CHANNELS = ["booking_com", "airbnb", "other_ota"];
// Stays that actually happened (or are going to) — cancellations counted apart.
const STAY_STATUSES = ["confirmed", "completed"];

/**
 * Match key for a phone: digits only, leading zeros/plus stripped.
 * "+62 (0)812-3456" and "0812 3456" both become "8123456" — good enough to
 * catch the same person typing their number two different ways, and cheap.
 */
function normalizePhone(s) {
  if (!s) return "";
  const digits = String(s).replace(/\D/g, "");
  return digits.replace(/^0+/, "");
}

function normalizeEmail(s) {
  return s ? String(s).trim().toLowerCase() : "";
}

function normalizeName(s) {
  return s ? String(s).trim() : "";
}

/** Escape a user-supplied string for safe use inside a RegExp. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find an existing guest by phone → email → exact name, in that order.
 * Name matching is last and exact (case-insensitive) on purpose: it's the
 * weakest signal, and merging two different "John Smith"s is worse than
 * leaving two records the owner can merge by hand.
 */
async function findMatch(workspaceId, { phone, email, name }) {
  const nPhone = normalizePhone(phone);
  if (nPhone) {
    const byPhone = await Guest.findOne({ workspaceId, phone: nPhone });
    if (byPhone) return byPhone;
  }
  const nEmail = normalizeEmail(email);
  if (nEmail) {
    const byEmail = await Guest.findOne({ workspaceId, email: nEmail });
    if (byEmail) return byEmail;
  }
  const nName = normalizeName(name);
  if (nName) {
    const byName = await Guest.findOne({
      workspaceId,
      name: new RegExp("^" + escapeRegex(nName) + "$", "i"),
    });
    if (byName) return byName;
  }
  return null;
}

/**
 * Add an identity to a guest if we haven't seen that (channel, externalId)
 * pair before. Mutates the doc; caller saves.
 */
function mergeIdentity(guest, identity) {
  if (!identity || !identity.channel) return false;
  const externalId = identity.externalId ? String(identity.externalId) : "";
  const contactId = identity.contactId ? String(identity.contactId) : "";

  const existing = guest.identities.find((i) => {
    if (i.channel !== identity.channel) return false;
    // Same external id, same contact, or a bare channel entry we can enrich.
    if (externalId && i.externalId) return String(i.externalId) === externalId;
    if (contactId && i.contactId) return String(i.contactId) === contactId;
    return !i.externalId && !i.contactId;
  });

  if (existing) {
    // Enrich a thin entry rather than duplicating it.
    let changed = false;
    if (externalId && !existing.externalId) {
      existing.externalId = externalId;
      changed = true;
    }
    if (contactId && !existing.contactId) {
      existing.contactId = identity.contactId;
      changed = true;
    }
    if (identity.handle && !existing.handle) {
      existing.handle = identity.handle;
      changed = true;
    }
    return changed;
  }

  guest.identities.push({
    channel: identity.channel,
    externalId: externalId || undefined,
    handle: identity.handle || undefined,
    contactId: identity.contactId || undefined,
    firstSeenAt: identity.firstSeenAt || new Date(),
  });
  return true;
}

/**
 * Recompute stats from scratch off this guest's bookings, and decide
 * directEligible. Mutates the doc; caller saves.
 *
 * Bookings belong to a guest when they match the same keys we matched on —
 * we can't store a guestId on HotelBooking (that model is owned elsewhere),
 * so we re-derive the set each time. Cheap at hotel scale.
 */
async function recomputeStats(guest) {
  const or = [];
  // Bookings store the phone exactly as the guest typed it ("+62 812 3456"),
  // so it can't be matched in Mongo against our digits-only key. Pull the
  // candidates on the fields we CAN match, then filter phone in JS below.
  if (guest.phone) {
    // Prefilter: the guest's digits in order, tolerating any separators the
    // guest may have typed between them ("812-3456", "812 3456", "8123456").
    const loose = guest.phone.split("").map(escapeRegex).join("[^0-9]*");
    or.push({ guestPhone: new RegExp(loose) });
  }
  if (guest.email) or.push({ guestEmail: guest.email });
  if (guest.name) {
    or.push({ guestName: new RegExp("^" + escapeRegex(guest.name) + "$", "i") });
  }
  if (!or.length) return;

  const candidates = await HotelBooking.find({
    workspaceId: guest.workspaceId,
    $or: or,
  })
    .select("status nights totalAmount currency checkIn source guestPhone guestEmail guestName")
    .sort({ checkIn: 1 })
    .lean();

  // Keep only the bookings that really are this guest, comparing phones on the
  // same normalized key we matched them by in the first place.
  const name = guest.name ? guest.name.toLowerCase() : "";
  const bookings = candidates.filter((b) => {
    if (guest.phone && normalizePhone(b.guestPhone) === guest.phone) return true;
    if (guest.email && normalizeEmail(b.guestEmail) === guest.email) return true;
    if (name && normalizeName(b.guestName).toLowerCase() === name) return true;
    return false;
  });

  const stats = {
    staysCount: 0,
    nightsTotal: 0,
    revenueTotal: 0,
    currency: guest.stats?.currency || "USD",
    firstStayAt: undefined,
    lastStayAt: undefined,
    lastChannel: undefined,
    cancellations: 0,
  };

  let hasOtaStay = false;
  for (const b of bookings) {
    if (b.status === "cancelled" || b.status === "no_show") {
      stats.cancellations++;
      continue;
    }
    if (!STAY_STATUSES.includes(b.status)) continue; // pending — not a stay yet

    stats.staysCount++;
    stats.nightsTotal += b.nights || 0;
    stats.revenueTotal += b.totalAmount || 0;
    if (b.currency) stats.currency = b.currency;
    if (!stats.firstStayAt || b.checkIn < stats.firstStayAt) {
      stats.firstStayAt = b.checkIn;
    }
    if (!stats.lastStayAt || b.checkIn >= stats.lastStayAt) {
      stats.lastStayAt = b.checkIn;
      stats.lastChannel = b.source;
    }
    if (OTA_CHANNELS.includes(b.source)) hasOtaStay = true;
  }

  stats.revenueTotal = Math.round(stats.revenueTotal * 100) / 100;
  guest.stats = stats;

  // The whole point: they came via an OTA AND they messaged us themselves.
  // That combination — and only that — makes them ours to talk to directly.
  const hasFirstPartyIdentity = guest.identities.some((i) =>
    FIRST_PARTY_CHANNELS.includes(i.channel),
  );
  guest.directEligible = Boolean(hasOtaStay && hasFirstPartyIdentity);
}

/**
 * Find-or-create the Guest behind a booking, fold in its identity, refresh
 * stats. Idempotent — safe to call for the same booking repeatedly.
 */
async function upsertGuestFromBooking(booking) {
  if (!booking || !booking.workspaceId) return null;

  const phone = normalizePhone(booking.guestPhone);
  const email = normalizeEmail(booking.guestEmail);
  const name = normalizeName(booking.guestName);
  // Nothing to match on and nothing to show — not a guest, just a row.
  if (!phone && !email && !name) return null;

  let guest = await findMatch(booking.workspaceId, { phone, email, name });
  if (!guest) {
    guest = new Guest({
      workspaceId: booking.workspaceId,
      name,
      phone,
      email,
    });
  } else {
    // Fill blanks only — never overwrite a known value with a booking's typo.
    if (!guest.name && name) guest.name = name;
    if (!guest.phone && phone) guest.phone = phone;
    if (!guest.email && email) guest.email = email;
  }

  mergeIdentity(guest, {
    channel: booking.source,
    externalId: booking.contactId || booking.otaReservationId || undefined,
    contactId: booking.contactId || undefined,
    firstSeenAt: booking.createdAt || new Date(),
  });

  await recomputeStats(guest);
  await guest.save();
  return guest;
}

/**
 * Same matching, for a guest who messages before they ever book. Keeps the
 * profile warm so the first booking lands on an existing record.
 */
async function upsertGuestFromContact(contact, workspace) {
  if (!contact) return null;
  const workspaceId = workspace?._id || workspace || contact.workspaceId;
  if (!workspaceId) return null;

  const phone = normalizePhone(contact.phone);
  const email = normalizeEmail(contact.email);
  const name = normalizeName(contact.name || contact.username);
  if (!phone && !email && !name) return null;

  let guest = await findMatch(workspaceId, { phone, email, name });
  if (!guest) {
    guest = new Guest({ workspaceId, name, phone, email });
  } else {
    if (!guest.name && name) guest.name = name;
    if (!guest.phone && phone) guest.phone = phone;
    if (!guest.email && email) guest.email = email;
  }

  const channel = FIRST_PARTY_CHANNELS.includes(contact.source)
    ? contact.source
    : contact.igUserId
      ? "instagram"
      : contact.phone
        ? "whatsapp"
        : "manual";

  mergeIdentity(guest, {
    channel,
    externalId: contact.igUserId || phone || undefined,
    handle: contact.igUsername || undefined,
    contactId: contact._id,
    firstSeenAt: contact.firstSeenAt || new Date(),
  });

  await recomputeStats(guest);
  await guest.save();
  return guest;
}

/**
 * Fold `secondary` into `primary` and delete it. Used when the owner spots two
 * records for the same person that our keys couldn't join (e.g. two phones).
 */
async function mergeGuests(primaryId, secondaryId) {
  if (String(primaryId) === String(secondaryId)) {
    return { ok: false, reason: "same_guest" };
  }
  const [primary, secondary] = await Promise.all([
    Guest.findById(primaryId),
    Guest.findById(secondaryId),
  ]);
  if (!primary || !secondary) return { ok: false, reason: "not_found" };
  if (String(primary.workspaceId) !== String(secondary.workspaceId)) {
    return { ok: false, reason: "different_workspace" };
  }

  if (!primary.name && secondary.name) primary.name = secondary.name;
  if (!primary.phone && secondary.phone) primary.phone = secondary.phone;
  if (!primary.email && secondary.email) primary.email = secondary.email;
  if (!primary.country && secondary.country) primary.country = secondary.country;
  if (!primary.language && secondary.language) {
    primary.language = secondary.language;
  }

  for (const identity of secondary.identities) {
    mergeIdentity(primary, identity);
  }
  for (const p of secondary.preferences || []) {
    if (!primary.preferences.includes(p)) primary.preferences.push(p);
  }
  for (const t of secondary.tags || []) {
    if (!primary.tags.includes(t)) primary.tags.push(t);
  }
  if (secondary.notes) {
    primary.notes = primary.notes
      ? primary.notes + "\n" + secondary.notes
      : secondary.notes;
  }

  await recomputeStats(primary); // re-derived, so no double counting
  await primary.save();
  await Guest.deleteOne({ _id: secondary._id });

  logger.info(
    `[guest] merged ${secondary._id} into ${primary._id} ws=${primary.workspaceId}`,
  );
  return { ok: true, guest: primary };
}

/** Record something we learned about a guest ("quiet room", "no nuts"). */
async function addPreference(guestId, text) {
  const value = String(text || "").trim();
  if (!value) return { ok: false, reason: "empty" };
  const guest = await Guest.findById(guestId);
  if (!guest) return { ok: false, reason: "not_found" };
  if (!guest.preferences.includes(value)) {
    guest.preferences.push(value);
    await guest.save();
  }
  return { ok: true, guest };
}

/** Paged guest list with a single search box over name / phone / email. */
async function listGuests({ workspaceId, query = "", page = 1, limit = 25 }) {
  const q = { workspaceId };
  const term = String(query || "").trim();
  if (term) {
    const rx = new RegExp(escapeRegex(term), "i");
    const or = [{ name: rx }, { email: rx }];
    const digits = normalizePhone(term);
    if (digits) or.push({ phone: new RegExp(escapeRegex(digits)) });
    q.$or = or;
  }

  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const safePage = Math.max(1, parseInt(page, 10) || 1);

  const [guests, total] = await Promise.all([
    Guest.find(q)
      .sort({ "stats.lastStayAt": -1, updatedAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    Guest.countDocuments(q),
  ]);

  return { guests, total, page: safePage, limit: safeLimit };
}

module.exports = {
  normalizePhone,
  upsertGuestFromBooking,
  upsertGuestFromContact,
  mergeGuests,
  addPreference,
  listGuests,
  FIRST_PARTY_CHANNELS,
  OTA_CHANNELS,
};
