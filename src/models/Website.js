const mongoose = require("mongoose");

/**
 * Website — the hotel's own public website, served at botlify.site/<slug>.
 *
 * One per property. The hotelier picks one of five templates; the content is
 * generated from the Property + RoomTypes at onboarding and then edited by the
 * hotelier in "Manage your website". Rooms are NOT copied here — they're read
 * live from RoomType on every request so prices never drift. Only optional
 * per-room presentation overrides (hide, description, image) live here.
 */
const TEMPLATE_IDS = ["coastal", "noir", "tropic", "urban", "heritage"];

// Paths that can never be a hotel slug: they collide with app routes on
// botlify.site (the SPA serves both) or are simply misleading.
const RESERVED_SLUGS = new Set([
  "api", "app", "admin", "book", "site", "sites", "login", "register", "signup",
  "dashboard", "onboarding", "pricing", "help", "docs", "guide", "contact",
  "privacy", "terms", "www", "mail", "static", "assets", "botlify", "support",
  "invite", "accounts", "verify-email", "reset-password", "forgot-password",
  "features", "consultants", "favicon.ico", "robots.txt", "sitemap.xml",
]);

const photoSchema = new mongoose.Schema(
  {
    url: { type: String, default: "" },
    caption: { type: String, default: "", maxlength: 200 },
    // true = one of our placeholder stock photos, not the hotel's own.
    stock: { type: Boolean, default: false },
  },
  { _id: false },
);

const websiteSchema = new mongoose.Schema(
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
      unique: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    templateId: { type: String, enum: TEMPLATE_IDS, default: "coastal" },
    published: { type: Boolean, default: true },
    // Digits only, international format without "+" (e.g. "6281234567890").
    whatsappNumber: { type: String, default: "" },
    accent: { type: String, default: "" }, // optional "#c9a96e" override
    content: {
      hero: {
        title: { type: String, default: "" },
        subtitle: { type: String, default: "" },
        image: { type: String, default: "" },
      },
      about: {
        heading: { type: String, default: "" },
        body: { type: String, default: "" },
        image: { type: String, default: "" },
      },
      highlights: [
        {
          _id: false,
          title: { type: String, default: "" },
          body: { type: String, default: "" },
        },
      ],
      amenities: [{ type: String }],
      gallery: [photoSchema],
      location: {
        address: { type: String, default: "" },
        mapQuery: { type: String, default: "" },
        directions: { type: String, default: "" },
      },
      contact: {
        phone: { type: String, default: "" },
        email: { type: String, default: "" },
        whatsapp: { type: String, default: "" },
      },
      testimonials: [
        {
          _id: false,
          quote: { type: String, default: "" },
          author: { type: String, default: "" },
          source: { type: String, default: "" }, // "Google", "Booking.com"
        },
      ],
      seo: {
        title: { type: String, default: "" },
        description: { type: String, default: "" },
      },
    },
    // Presentation-only tweaks per room; the room itself stays in RoomType.
    roomOverrides: [
      {
        _id: false,
        roomTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "RoomType" },
        hidden: { type: Boolean, default: false },
        description: { type: String, default: "" },
        image: { type: String, default: "" },
      },
    ],
    generatedAt: Date,
  },
  { timestamps: true },
);

websiteSchema.statics.TEMPLATE_IDS = TEMPLATE_IDS;
websiteSchema.statics.RESERVED_SLUGS = RESERVED_SLUGS;

module.exports = mongoose.model("Website", websiteSchema);
module.exports.TEMPLATE_IDS = TEMPLATE_IDS;
module.exports.RESERVED_SLUGS = RESERVED_SLUGS;
