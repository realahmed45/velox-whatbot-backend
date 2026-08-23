const mongoose = require("mongoose");

/**
 * Guest — ONE person, however many channels and OTAs they arrived through.
 *
 * A guest who booked on Booking.com in March, DM'd on Instagram in June and
 * WhatsApp'd about a transfer in July is three records everywhere else. Here
 * they're one, matched on phone → email → (name + property). This is the asset
 * that makes leaving Botlify expensive.
 */
const guestSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: { type: String, default: "" },
    // Normalized digits-only phone (match key).
    phone: { type: String, default: "", index: true },
    email: { type: String, default: "", lowercase: true, trim: true, index: true },
    country: { type: String, default: "" },
    language: { type: String, default: "" },
    // Every identity we've seen this person under.
    identities: [
      {
        channel: {
          type: String,
          enum: [
            "whatsapp", "instagram", "tiktok", "booking_com",
            "airbnb", "direct", "manual", "other_ota",
          ],
        },
        externalId: String, // IG id / phone / OTA guest id
        handle: String,
        contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
        firstSeenAt: { type: Date, default: Date.now },
      },
    ],
    // Rolled-up stay history (kept current by guestService).
    stats: {
      staysCount: { type: Number, default: 0 },
      nightsTotal: { type: Number, default: 0 },
      revenueTotal: { type: Number, default: 0 },
      currency: { type: String, default: "USD" },
      firstStayAt: Date,
      lastStayAt: Date,
      lastChannel: String,
      cancellations: { type: Number, default: 0 },
    },
    // Free-form things the bot/staff learned ("quiet room", "allergic to nuts").
    preferences: [{ type: String }],
    tags: [{ type: String }],
    // True once they've stayed via an OTA AND messaged us first-party — the
    // legitimate direct-rebooking audience (never sourced from OTA contact data).
    directEligible: { type: Boolean, default: false },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

guestSchema.index({ workspaceId: 1, "stats.lastStayAt": -1 });
// `language` is a reserved field name for text indexes (Mongo reads it as the
// per-document language override and rejects unknown/empty values), so point
// the override at a field we never set.
guestSchema.index(
  { workspaceId: 1, name: "text" },
  { language_override: "_textLanguage" },
);

module.exports = mongoose.model("Guest", guestSchema);
