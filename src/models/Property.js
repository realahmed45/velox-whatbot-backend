const mongoose = require("mongoose");

/**
 * Property — one hotel/guesthouse/villa owned by a workspace.
 * Content is imported from Booking.com/Airbnb via Channex at onboarding, or
 * entered manually. Room inventory lives in RoomType.
 */
const propertySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", maxlength: 8000 },
    propertyType: {
      type: String,
      enum: ["hotel", "guesthouse", "villa", "hostel", "apartment", "resort"],
      default: "hotel",
    },
    // Location
    address: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    country: { type: String, default: "" }, // ISO-2 preferred (e.g. "ID")
    zipCode: { type: String, default: "" },
    latitude: Number,
    longitude: Number,
    timezone: { type: String, default: "Asia/Makassar" }, // Bali default
    // Presentation
    photos: [
      {
        url: String,
        caption: { type: String, default: "" },
        position: { type: Number, default: 0 },
      },
    ],
    amenities: [{ type: String }],
    starRating: { type: Number, min: 0, max: 5, default: 0 },
    // Money
    currency: { type: String, default: "USD" }, // rates currency (e.g. IDR/USD)
    // Policies
    checkInTime: { type: String, default: "14:00" },
    checkOutTime: { type: String, default: "11:00" },
    policies: { type: String, default: "", maxlength: 4000 },

    // ── Structured house rules ──────────────────────────────────────────────
    // Free-text `policies` above is for anything unusual. These are the rules
    // guests ask about by name, kept structured so the AI can answer them
    // directly instead of paraphrasing a paragraph.
    rules: {
      childrenWelcome: { type: Boolean, default: true },
      // Children at or above this age are charged as adults.
      childAgeLimit: { type: Number, default: 12 },
      cotsAvailable: { type: Boolean, default: false },
      cotPrice: { type: Number, default: 0 },
      petsAllowed: { type: Boolean, default: false },
      petFee: { type: Number, default: 0 },
      smokingAllowed: { type: Boolean, default: false },
      partiesAllowed: { type: Boolean, default: false },
      quietHours: { type: String, default: "" }, // "22:00 - 07:00"
      minAge: { type: Number, default: 0 }, // 0 = no minimum check-in age
    },

    // How guests can pay at the property — the AI tells them, and it shapes
    // what a direct booking confirmation should say.
    paymentMethods: {
      cash: { type: Boolean, default: true },
      card: { type: Boolean, default: false },
      bankTransfer: { type: Boolean, default: false },
      qris: { type: Boolean, default: false }, // Indonesia
      eWallet: { type: Boolean, default: false }, // GoPay/OVO/DANA
      payAtProperty: { type: Boolean, default: true },
      depositRequired: { type: Boolean, default: false },
      depositPercent: { type: Number, default: 0 },
    },
    // Contact shown to guests in confirmations
    phone: { type: String, default: "" },
    email: { type: String, default: "" },

    // ── OTA connectivity (channel-provider abstraction) ─────────────────────
    // provider "channex" = real-time API sync; "ical" = free availability-only
    // tier for single-unit properties; "none" = direct/social only.
    channel: {
      provider: {
        type: String,
        enum: ["none", "channex", "ical"],
        default: "none",
      },
      status: {
        type: String,
        enum: ["disconnected", "pending", "connected", "error"],
        default: "disconnected",
      },
      // Channex ids
      channexPropertyId: { type: String, default: null },
      channexGroupId: { type: String, default: null },
      // Which OTAs are live on the Channex side (informational, from import).
      // Written from REAL connection state — never from user intent.
      connectedOtas: [{ type: String }], // e.g. ["booking_com", "airbnb"]
      // Which OTAs the hotel told us they're listed on, captured at onboarding
      // before any connection exists. Kept separate from connectedOtas so the
      // UI can never claim a channel is synced when it merely was requested.
      requestedOtas: [{ type: String }],
      lastSyncAt: Date,
      lastError: { type: String, default: null },
      // iCal tier
      icalImportUrls: [
        {
          source: { type: String, default: "" }, // "airbnb" | "booking_com" | other
          url: { type: String, default: "" },
          roomTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "RoomType" },
          lastSyncAt: Date,
        },
      ],
    },

    // ── Airport transfers ───────────────────────────────────────────────────
    transfers: {
      // Does the hotel run its own pickup service? (asked at onboarding)
      hasOwnService: { type: Boolean, default: false },
      // If they do: flat price the bot quotes for their own service.
      ownServicePrice: { type: Number, default: 0 },
      ownServiceNotes: { type: String, default: "" },
      // If they don't: offer partner transfers (Mozio) on their behalf.
      offerPartnerService: { type: Boolean, default: true },
      airportCode: { type: String, default: "DPS" }, // nearest airport (IATA)
    },

    // ── Upsell catalog ──────────────────────────────────────────────────────
    // What the bot may offer on top of a stay. Seeded with sensible defaults at
    // onboarding; the hotel edits prices or switches items off.
    upsells: [
      {
        key: { type: String, required: true }, // early_checkin, upgrade, ...
        label: { type: String, required: true },
        price: { type: Number, default: 0 },
        enabled: { type: Boolean, default: true },
        description: { type: String, default: "" },
      },
    ],

    // ── Direct booking page ─────────────────────────────────────────────────
    // Public page at /book/<slug> — their rooms, their photos, 0% OTA fee.
    directBooking: {
      enabled: { type: Boolean, default: true },
      slug: { type: String, default: null },
    },

    // ── Revenue manager ─────────────────────────────────────────────────────
    revenue: {
      enabled: { type: Boolean, default: true },
      // Owner-approved guard rails the engine may never price outside of.
      minRate: { type: Number, default: 0 },
      maxRate: { type: Number, default: 0 },
      // "suggest" = owner taps approve (default). "auto" = engine pushes itself.
      mode: { type: String, enum: ["suggest", "auto"], default: "suggest" },
    },

    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// Public direct-booking slug must be globally unique when set.
propertySchema.index(
  { "directBooking.slug": 1 },
  {
    unique: true,
    partialFilterExpression: { "directBooking.slug": { $type: "string" } },
  },
);

propertySchema.index(
  { "channel.channexPropertyId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "channel.channexPropertyId": { $type: "string" },
    },
  },
);

/**
 * Seed sensible defaults on creation so a brand-new property is immediately
 * useful: the extras the bot may sell, and a public booking slug. Done here
 * (not in a controller) so every creation path — manual, Channex import,
 * migration — gets the same result.
 */
propertySchema.pre("save", function (next) {
  if (this.isNew) {
    if (!this.upsells || !this.upsells.length) {
      this.upsells = [
        { key: "early_checkin", label: "Early check-in", price: 0, enabled: true },
        { key: "late_checkout", label: "Late check-out", price: 0, enabled: true },
        { key: "breakfast", label: "Breakfast", price: 0, enabled: true },
        { key: "airport_pickup", label: "Airport pickup", price: 0, enabled: true },
        { key: "room_upgrade", label: "Room upgrade", price: 0, enabled: true },
      ];
    }
    if (this.directBooking && !this.directBooking.slug && this.name) {
      const base = String(this.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
      const suffix = Math.random().toString(36).slice(2, 7);
      this.directBooking.slug = (base || "stay") + "-" + suffix;
    }
  }
  next();
});

module.exports = mongoose.model("Property", propertySchema);
