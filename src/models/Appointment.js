const mongoose = require("mongoose");

/**
 * Appointment — a booking the AI captured from a DM conversation, or one
 * created/managed from the dashboard. Mirrors the Order model's shape so the
 * booking flow reuses the same "AI emits a JSON block → we persist + notify"
 * pattern (see automationEngine + services/ai).
 *
 * `startAt`/`endAt` are absolute UTC instants; the slot engine computes them
 * from the workspace timezone so availability math is timezone-correct.
 */
const appointmentSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },
    igUsername: { type: String, default: "" },

    // Who booked
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    customerEmail: { type: String, default: "" },

    // What & when
    service: { type: String, default: "" },
    durationMinutes: { type: Number, default: 30 },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true },
    notes: { type: String, default: "" },

    // Lifecycle. "pending" = awaiting business approval (requireApproval on).
    status: {
      type: String,
      enum: ["pending", "confirmed", "completed", "cancelled", "no_show"],
      default: "confirmed",
      index: true,
    },

    // Where the booking originated.
    source: {
      type: String,
      enum: ["bot", "manual", "customer"],
      default: "bot",
    },

    // Confirmation delivery bookkeeping (so we never double-send).
    customerNotifiedAt: Date,
    businessNotifiedAt: Date,
  },
  { timestamps: true },
);

// Fast availability lookups: all bookings for a workspace in a time range.
appointmentSchema.index({ workspaceId: 1, startAt: 1 });
// Guard against exact double-booking of the same slot for single-capacity.
appointmentSchema.index({ workspaceId: 1, startAt: 1, status: 1 });

module.exports = mongoose.model("Appointment", appointmentSchema);
