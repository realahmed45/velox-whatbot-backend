const mongoose = require("mongoose");

/**
 * DemoRequest — a public "Book a Demo" submission from the marketing site.
 * Unauthenticated: captured before signup so we can follow up with the lead.
 */
const demoRequestSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true },
    phone: { type: String, default: "" },
    business: { type: String, default: "" },
    preferredTime: { type: String, default: "" },
    message: { type: String, default: "" },
    // Light anti-abuse / attribution context.
    source: { type: String, default: "header" },
    status: {
      type: String,
      enum: ["new", "contacted", "done", "spam"],
      default: "new",
      index: true,
    },
  },
  { timestamps: true },
);

demoRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model("DemoRequest", demoRequestSchema);
