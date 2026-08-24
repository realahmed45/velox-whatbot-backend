const mongoose = require("mongoose");

/**
 * RoomType — a bookable room category of a Property (e.g. "Deluxe Double").
 * `unitsCount` is how many physical rooms of this type exist; availability for
 * a date range = unitsCount − overlapping active bookings (see
 * services/hotel/availability.js).
 */
const roomTypeSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    propertyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Property",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", maxlength: 4000 },
    photos: [
      {
        url: String,
        caption: { type: String, default: "" },
        position: { type: Number, default: 0 },
      },
    ],
    // Physical inventory of this room type.
    unitsCount: { type: Number, default: 1, min: 1 },
    // Occupancy
    maxAdults: { type: Number, default: 2 },
    maxChildren: { type: Number, default: 1 },
    maxOccupancy: { type: Number, default: 2 },
    bedConfig: { type: String, default: "" }, // "1 king bed" / "2 twin beds"
    sizeSqm: Number,
    amenities: [{ type: String }],
    // Pricing — base nightly rate in the property currency. Seasonal/derived
    // pricing stays on the OTA side (Channex) for v1; the bot quotes this rate
    // for direct/social bookings.
    baseRate: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    // The rate above covers this many guests; each extra guest adds extraGuestFee.
    // This is how hotels actually price, and the AI needs it to quote a family
    // correctly rather than quoting the couple price.
    baseOccupancy: { type: Number, default: 2 },
    extraGuestFee: { type: Number, default: 0 },

    // ── What the guest actually asks about ──────────────────────────────────
    // Every field here exists because a guest asks it before booking. Without
    // it the AI has to say "let me check with the team", which defeats the
    // point of the concierge.
    breakfast: {
      included: { type: Boolean, default: false },
      price: { type: Number, default: 0 }, // per person per night when not included
    },
    cancellation: {
      policy: {
        type: String,
        enum: ["free_until", "non_refundable", "flexible"],
        default: "free_until",
      },
      // Free cancellation up to N days before check-in (free_until only).
      freeUntilDays: { type: Number, default: 1 },
      note: { type: String, default: "" },
    },
    bathroom: {
      type: String,
      enum: ["private", "shared", "ensuite"],
      default: "private",
    },
    smokingAllowed: { type: Boolean, default: false },
    // ── Housekeeping (PMS-lite) ─────────────────────────────────────────────
    // One entry per physical unit of this room type. Staff flip status from a
    // phone; the Calendar screen shows the board. Kept here (not a separate
    // model) because a unit only ever belongs to one room type.
    units: [
      {
        label: { type: String, default: "" }, // "101", "Villa 2"
        housekeeping: {
          type: String,
          enum: ["clean", "dirty", "inspected", "out_of_service"],
          default: "clean",
        },
        note: { type: String, default: "" },
        updatedAt: Date,
      },
    ],

    // Channel-manager mapping — whichever provider the parent property uses.
    // Channex
    channexRoomTypeId: { type: String, default: null },
    channexRatePlanId: { type: String, default: null },
    // Beds24 (no rate-plan equivalent: prices live per-date on the room's
    // calendar, in the price1..price16 slots, so one id is enough).
    beds24RoomId: { type: String, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

roomTypeSchema.index({ propertyId: 1, name: 1 });

module.exports = mongoose.model("RoomType", roomTypeSchema);
