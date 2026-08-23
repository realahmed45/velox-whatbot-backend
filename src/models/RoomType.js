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

    // Channex mapping
    channexRoomTypeId: { type: String, default: null },
    channexRatePlanId: { type: String, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

roomTypeSchema.index({ propertyId: 1, name: 1 });

module.exports = mongoose.model("RoomType", roomTypeSchema);
