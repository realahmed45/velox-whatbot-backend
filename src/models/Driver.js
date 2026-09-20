const mongoose = require("mongoose");

/**
 * Driver — someone who can be dispatched to collect a guest.
 *
 * Two kinds live in this one collection, told apart by `scope`:
 *
 *  - scope "platform" : Botlify's own pool, managed in /admin. Used for hotels
 *                       that told us at onboarding they have no taxi service.
 *                       `workspaceId` is null — they are shared across hotels.
 *  - scope "hotel"    : the hotel's own driver(s), entered at onboarding or in
 *                       Settings. Only ever dispatched for that workspace.
 *
 * Why one collection: dispatch reads the same shape either way, so the rotation
 * engine never branches on who owns the driver — it just asks for the candidate
 * list. Keeping them apart would duplicate every query and every screen.
 *
 * Identity documents are recorded because a hotel is handing a stranger their
 * guest. We store the number and expiry, never a scan or image — the less of
 * that we hold, the less there is to leak.
 */
const driverSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ["platform", "hotel"],
      required: true,
      index: true,
    },
    // Set for scope "hotel", null for the shared platform pool.
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
      index: true,
    },

    // ── Who they are ────────────────────────────────────────────────────────
    name: { type: String, required: true, trim: true },
    // What the guest is told to look for — "Ask for Wayan". Falls back to the
    // first name when empty.
    nickname: { type: String, default: "", trim: true },
    // E.164. This is the number we give the guest, so it must be WhatsApp-capable.
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    languages: [{ type: String }],
    photoUrl: { type: String, default: "" },

    // ── Identity / compliance ───────────────────────────────────────────────
    // Number + expiry only, never an uploaded document.
    idType: {
      type: String,
      enum: ["ktp", "passport", "driving_licence", "other"],
      default: "ktp",
    },
    idNumber: { type: String, default: "", trim: true },
    idExpiry: { type: Date, default: null },
    licenceNumber: { type: String, default: "", trim: true },
    licenceExpiry: { type: Date, default: null },

    // ── Vehicle ─────────────────────────────────────────────────────────────
    vehicle: {
      make: { type: String, default: "" },
      model: { type: String, default: "" },
      colour: { type: String, default: "" },
      plate: { type: String, default: "", trim: true },
      seats: { type: Number, default: 4 },
    },

    // ── Dispatch ────────────────────────────────────────────────────────────
    // Where they work. Empty = anywhere (the platform pool default).
    serviceAreas: [{ type: String }],
    // Lower goes first in the rotation. Ties break on fewest recent jobs, so a
    // flat default still spreads work rather than hammering whoever sorts first.
    priority: { type: Number, default: 100 },
    active: { type: Boolean, default: true, index: true },
    // Set by an admin to park a driver without deleting their history.
    suspendedReason: { type: String, default: "" },

    // The private link a driver opens to accept or decline a job. Random,
    // unguessable, and rotatable if it leaks — see rotateDispatchToken().
    dispatchToken: { type: String, index: true, unique: true, sparse: true },

    // ── Stats (denormalised so dispatch doesn't aggregate on every job) ─────
    stats: {
      offered: { type: Number, default: 0 },
      accepted: { type: Number, default: 0 },
      declined: { type: Number, default: 0 },
      missed: { type: Number, default: 0 }, // offered, never answered
      completed: { type: Number, default: 0 },
      lastOfferedAt: { type: Date, default: null },
      lastAcceptedAt: { type: Date, default: null },
    },

    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

// The rotation's hot path: active drivers for a scope, best candidate first.
driverSchema.index({ scope: 1, workspaceId: 1, active: 1, priority: 1 });

/** Name the guest is given. Nickname if set, else the first name. */
driverSchema.virtual("displayName").get(function () {
  return this.nickname || String(this.name || "").split(" ")[0] || this.name;
});

/** "Silver Toyota Avanza · DK 1234 AB" — what the guest looks for at arrivals. */
driverSchema.virtual("vehicleLabel").get(function () {
  const v = this.vehicle || {};
  const desc = [v.colour, v.make, v.model].filter(Boolean).join(" ");
  return [desc, v.plate].filter(Boolean).join(" · ");
});

driverSchema.set("toJSON", { virtuals: true });
driverSchema.set("toObject", { virtuals: true });

module.exports =
  mongoose.models.Driver || mongoose.model("Driver", driverSchema);
