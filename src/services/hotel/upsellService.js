/**
 * upsellService — the extras engine.
 *
 * The CATALOG lives on Property.upsells[] (what this hotel offers, at what
 * price). This service turns a catalog entry into an OFFER (an Upsell row),
 * and an accepted offer into (a) a folio line on the stay and (b) a 10%
 * platform commission in the ledger — exactly like a bot-closed booking.
 *
 * Every function returns { ok, ... } and never throws; side effects (ledger)
 * are best-effort and can never fail the accept.
 */
const Upsell = require("../../models/Upsell");
const HotelBooking = require("../../models/HotelBooking");
const logger = require("../../utils/logger");
const { SOCIAL_BOOKING_COMMISSION_RATE } = require("../../config/plans");

/**
 * The catalog every new property is seeded with at onboarding. Prices are 0 —
 * the hotel sets its own in the dashboard; an item priced 0 is still offerable
 * (a free early check-in is a perfectly good upsell).
 */
const DEFAULT_UPSELLS = [
  {
    key: "early_checkin",
    label: "Early check-in",
    price: 0,
    enabled: true,
    description: "Get into your room before the standard check-in time.",
  },
  {
    key: "late_checkout",
    label: "Late check-out",
    price: 0,
    enabled: true,
    description: "Keep your room a few hours past the standard check-out time.",
  },
  {
    key: "airport_pickup",
    label: "Airport pickup",
    price: 0,
    enabled: true,
    description: "A driver meets you at the airport and brings you to us.",
  },
  {
    key: "breakfast",
    label: "Breakfast",
    price: 0,
    enabled: true,
    description: "Breakfast added to your stay.",
  },
  {
    key: "room_upgrade",
    label: "Room upgrade",
    price: 0,
    enabled: true,
    description: "Move up to a better room, subject to availability.",
  },
];

/** Enabled catalog entries for a property (falls back to nothing, never throws). */
function listAvailable(property) {
  const catalog = Array.isArray(property?.upsells) ? property.upsells : [];
  return catalog.filter((u) => u && u.key && u.enabled !== false);
}

/** Find one enabled catalog entry by key. */
function findCatalogEntry(property, key) {
  return listAvailable(property).find((u) => u.key === String(key)) || null;
}

/**
 * Offer an extra to a guest — records the offer so we know what was pitched
 * and can attribute the accept later. Idempotent per (booking, key): an offer
 * already sitting in "offered" is returned as-is instead of duplicated.
 *
 * @returns {Promise<{ok, upsell?, reason?}>}
 */
async function offerUpsell({ workspace, booking, key, quantity = 1 }) {
  try {
    if (!workspace?._id || !booking?._id || !key)
      return { ok: false, reason: "missing_args" };

    const Property = require("../../models/Property");
    const property = await Property.findById(booking.propertyId);
    const entry = findCatalogEntry(property, key);
    if (!entry) return { ok: false, reason: "not_in_catalog" };

    const existing = await Upsell.findOne({
      bookingId: booking._id,
      key: entry.key,
      status: "offered",
    });
    if (existing) return { ok: true, upsell: existing };

    const upsell = await Upsell.create({
      workspaceId: workspace._id,
      bookingId: booking._id,
      contactId: booking.contactId,
      key: entry.key,
      label: entry.label || entry.key,
      price: Number(entry.price) || 0,
      currency: booking.currency || property?.currency || "USD",
      quantity: Math.max(1, Number(quantity) || 1),
      status: "offered",
    });
    logger.info(
      `[upsell] offered ws=${workspace._id} booking=${booking.code || booking._id} key=${entry.key}`,
    );
    return { ok: true, upsell };
  } catch (e) {
    logger.warn("[upsell] offer failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/**
 * Accept an extra. Either pass the upsellId, or (bookingId + key) — the latter
 * is what the AI path uses, and it creates the row on the fly when the guest
 * accepts something we never formally offered.
 *
 * On accept we: flip the status, push a folio line onto the stay, and record
 * 10% of the upsell value as platform revenue (same rate as a bot booking).
 *
 * @returns {Promise<{ok, upsell?, reason?, confirmationText?}>}
 */
async function acceptUpsell({ workspace, upsellId, bookingId, key, quantity }) {
  try {
    let upsell = null;

    if (upsellId) {
      upsell = await Upsell.findOne({
        _id: upsellId,
        ...(workspace?._id ? { workspaceId: workspace._id } : {}),
      });
    } else if (bookingId && key) {
      upsell = await Upsell.findOne({
        bookingId,
        key: String(key),
        status: { $in: ["offered", "accepted"] },
      }).sort({ createdAt: -1 });
    }

    // Guest accepted something we never offered — create it from the catalog.
    if (!upsell && bookingId && key) {
      const booking = await HotelBooking.findById(bookingId);
      if (!booking) return { ok: false, reason: "booking_not_found" };
      const offered = await offerUpsell({
        workspace: workspace || { _id: booking.workspaceId },
        booking,
        key,
        quantity,
      });
      if (!offered.ok) return offered;
      upsell = offered.upsell;
    }

    if (!upsell) return { ok: false, reason: "not_found" };
    if (upsell.status === "accepted")
      return { ok: true, upsell, confirmationText: confirmationFor(upsell) };
    if (upsell.status === "cancelled")
      return { ok: false, reason: "cancelled" };

    if (quantity) upsell.quantity = Math.max(1, Number(quantity) || 1);
    upsell.status = "accepted";
    upsell.respondedAt = new Date();
    await upsell.save();

    const qty = Math.max(1, Number(upsell.quantity) || 1);
    const value = Math.round(Number(upsell.price || 0) * qty * 100) / 100;

    // Folio line on the stay so the front desk bills it at checkout.
    try {
      await HotelBooking.updateOne(
        { _id: upsell.bookingId },
        {
          $push: {
            folio: {
              label: upsell.label,
              amount: Number(upsell.price) || 0,
              quantity: qty,
              upsellId: upsell._id,
              addedAt: new Date(),
            },
          },
        },
      );
    } catch (e) {
      logger.warn("[upsell] folio push failed", { err: e.message });
    }

    // Commission ledger — 10% of the upsell value, best-effort.
    if (value > 0) {
      try {
        const { recordRevenue } = require("../commissionService");
        const entry = await recordRevenue({
          workspaceId: upsell.workspaceId,
          type: "booking_commission",
          amount:
            Math.round(value * SOCIAL_BOOKING_COMMISSION_RATE * 100) / 100,
          currency: upsell.currency || "USD",
          rate: SOCIAL_BOOKING_COMMISSION_RATE,
          bookingId: upsell.bookingId,
          reference: `upsell:${upsell.key}`,
        });
        if (entry) {
          upsell.ledgerEntryId = entry._id;
          await upsell.save();
        }
      } catch (e) {
        logger.warn("[upsell] ledger failed", { err: e.message });
      }
    }

    logger.info(
      `[upsell] accepted ws=${upsell.workspaceId} key=${upsell.key} value=${value} ${upsell.currency}`,
    );
    return { ok: true, upsell, confirmationText: confirmationFor(upsell) };
  } catch (e) {
    logger.warn("[upsell] accept failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/** Guest said no (or the hotel withdrew it). */
async function declineUpsell(id, workspaceId) {
  try {
    const upsell = await Upsell.findOne({
      _id: id,
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!upsell) return { ok: false, reason: "not_found" };
    if (upsell.status === "accepted") return { ok: false, reason: "accepted" };
    upsell.status = "declined";
    upsell.respondedAt = new Date();
    await upsell.save();
    return { ok: true, upsell };
  } catch (e) {
    logger.warn("[upsell] decline failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/** Short line we append to the bot's reply so the guest sees it landed. */
function confirmationFor(upsell) {
  const qty = Math.max(1, Number(upsell.quantity) || 1);
  const price = Number(upsell.price) || 0;
  const total = Math.round(price * qty * 100) / 100;
  return (
    `Added: ${upsell.label}${qty > 1 ? ` ×${qty}` : ""}` +
    (total > 0 ? ` — ${upsell.currency} ${total}, charged at checkout ✅` : " ✅")
  );
}

/**
 * The prompt block that teaches the bot what it may sell and how to report a
 * yes. Empty string when the property has nothing enabled.
 *
 * @param {object} property   the guest's property (catalog source)
 * @param {object} [booking]  the guest's current stay, when they have one
 */
function buildUpsellPromptBlock(property, booking) {
  const items = listAvailable(property);
  if (!items.length) return "";

  const currency = booking?.currency || property?.currency || "USD";
  const lines = items.map(
    (u) =>
      `  • ${u.label} [key: ${u.key}]` +
      (Number(u.price) > 0 ? ` — ${currency} ${u.price}` : " — included") +
      (u.description ? ` (${u.description})` : ""),
  );

  return [
    "EXTRAS YOU MAY OFFER (only these, only at these prices):",
    ...lines,
    "",
    "Mention an extra when it genuinely fits what the guest is asking about — never list them all unprompted.",
    'When the guest clearly says YES to one, add this marker line ABOVE your reply: <<UPSELL_JSON>>{"key":"early_checkin","quantity":1}<<END_UPSELL>>',
    "Emit it once, only on a clear yes, and never mention the marker to the guest — just confirm warmly in your own words.",
  ].join("\n");
}

module.exports = {
  DEFAULT_UPSELLS,
  listAvailable,
  findCatalogEntry,
  offerUpsell,
  acceptUpsell,
  declineUpsell,
  buildUpsellPromptBlock,
};
