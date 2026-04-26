/**
 * Botlify — Link in Bio model
 * Public-facing mini landing page hosted at botlify.site/@username
 */
const mongoose = require("mongoose");

const linkSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    url: { type: String, required: true, trim: true },
    icon: { type: String, default: "link" }, // lucide icon key
    enabled: { type: Boolean, default: true },
    clicks: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
  },
  { _id: true, timestamps: false },
);

const linkInBioSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: /^[a-z0-9_-]{3,32}$/,
    },
    displayName: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 200 },
    avatarUrl: { type: String, default: "" },
    theme: {
      type: String,
      enum: ["light", "dark", "brand", "gradient"],
      default: "brand",
    },
    accentColor: { type: String, default: "#6366f1" },
    links: [linkSchema],
    totalViews: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("LinkInBio", linkInBioSchema);
