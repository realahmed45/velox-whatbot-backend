const mongoose = require("mongoose");

/**
 * AdminEvent — a lightweight, append-only activity log for the admin panel.
 * Records notable lifecycle events (signup, onboarding, IG connect, payment,
 * knowledge added, etc.) so the admin can see a live timeline of what every
 * user is doing. Best-effort: recording failures never break the main flow.
 */
const adminEventSchema = new mongoose.Schema(
  {
    // What happened — a stable machine key (see EVENTS below).
    type: { type: String, required: true, index: true },
    // Human-readable one-liner shown in the timeline.
    message: { type: String, default: "" },

    // Who / where (all optional so events can be recorded from any context).
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    userEmail: { type: String, default: "" },
    userName: { type: String, default: "" },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      index: true,
    },

    // Free-form extras (plan, amount, ig username, source, etc.)
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

adminEventSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AdminEvent", adminEventSchema);
