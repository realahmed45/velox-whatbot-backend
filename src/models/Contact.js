const mongoose = require("mongoose");

const customFieldValueSchema = new mongoose.Schema(
  {
    fieldName: String,
    value: mongoose.Schema.Types.Mixed,
  },
  { _id: false },
);

const contactSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    phone: { type: String, trim: true },
    name: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },

    // Instagram fields
    igUserId: { type: String, trim: true, index: true, sparse: true },
    igUsername: { type: String, trim: true },
    igProfilePic: { type: String },
    igFollowsYou: { type: Boolean },

    // Captured variables from flows
    variables: { type: Map, of: String, default: {} },

    // Custom tags
    tags: [{ type: String, lowercase: true, trim: true }],

    // VIP flag (set by VIP Comment Prioritizer or manually)
    isVip: { type: Boolean, default: false },

    // Custom fields
    customFields: [customFieldValueSchema],

    // Stats
    messageCount: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    lastMessageAt: Date,

    // Internal notes
    notes: [
      {
        content: String,
        addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    // GDPR
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,

    optedIn: { type: Boolean, default: true },
    optedOut: { type: Boolean, default: false },
    optedOutAt: Date,

    // Last automation trigger that touched this contact
    lastTriggerType: String,
    source: { type: String, default: "instagram" },

    // Free-form display name fallback
    username: { type: String, trim: true },
  },
  {
    timestamps: true,
  },
);

// Unique contact per workspace per phone (sparse — allows null for IG-only contacts)
contactSchema.index(
  { workspaceId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } } },
);
contactSchema.index(
  { workspaceId: 1, igUserId: 1 },
  { unique: true, partialFilterExpression: { igUserId: { $type: "string" } } },
);
contactSchema.index({ workspaceId: 1, tags: 1 });
contactSchema.index({ workspaceId: 1, lastSeenAt: -1 });

module.exports = mongoose.model("Contact", contactSchema);
