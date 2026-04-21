const mongoose = require("mongoose");

const businessHoursSchema = new mongoose.Schema(
  {
    day: {
      type: String,
      enum: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
    },
    isOpen: { type: Boolean, default: true },
    openTime: { type: String, default: "09:00" },
    closeTime: { type: String, default: "18:00" },
  },
  { _id: false },
);

const instagramConnectionSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["connected", "disconnected", "pending", "error"],
      default: "disconnected",
    },
    // Meta OAuth fields (encrypted at rest)
    igUserId: { type: String, select: false },
    accessToken: { type: String, select: false },
    pageId: { type: String, select: false },
    pageAccessToken: { type: String, select: false },
    // Public display fields
    username: String,
    displayName: String,
    profilePicture: String,
    followersCount: Number,
    // Session-cookie fallback (encrypted)
    sessionCookie: { type: String, select: false },
    connectionType: {
      type: String,
      enum: ["meta_oauth", "session_cookie"],
      default: "meta_oauth",
    },
    connectedAt: Date,
    tokenExpiresAt: Date,
    lastMessageAt: Date,
  },
  { _id: false },
);

const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, lowercase: true },
    industry: {
      type: String,
      enum: [
        "restaurant",
        "beauty_salon",
        "retail",
        "real_estate",
        "healthcare",
        "freelancer",
        "auto_hardware",
        "ecommerce",
        "fitness",
        "education",
        "influencer",
        "general",
        "other",
      ],
      required: true,
    },
    logo: String,
    businessHours: [businessHoursSchema],
    timezone: { type: String, default: "Asia/Karachi" },

    // Members
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    members: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        role: { type: String, enum: ["owner", "agent"], default: "agent" },
        invitedAt: Date,
        joinedAt: Date,
      },
    ],

    // Instagram connection
    instagram: instagramConnectionSchema,

    // Subscription
    subscription: {
      plan: {
        type: String,
        enum: ["starter", "growth", "business", "agency"],
        default: "starter",
      },
      status: {
        type: String,
        enum: ["active", "suspended", "cancelled", "past_due"],
        default: "active",
      },
      currentPeriodStart: Date,
      currentPeriodEnd: Date,
      cancelAtPeriodEnd: { type: Boolean, default: false },
      billingCycleAnchor: Date,
    },

    // Usage tracking (resets monthly)
    usage: {
      messagesThisMonth: { type: Number, default: 0 },
      messagesLimit: { type: Number, default: 500 }, // Starter: 500
      lastResetDate: { type: Date, default: Date.now },
    },

    // Settings
    settings: {
      automationEnabled: { type: Boolean, default: true },
      minDelayMinutes: { type: Number, default: 2 },
      maxDelayMinutes: { type: Number, default: 5 },
      activeHourStart: { type: Number, default: 0 },
      activeHourEnd: { type: Number, default: 23 },
      quietSunday: { type: Boolean, default: false },
      flowgramBrandingEnabled: { type: Boolean, default: true },
      notifyOnNewFollower: { type: Boolean, default: true },
      usageAlerts: { type: Boolean, default: true },
    },

    // Agency
    isAgencyManaged: { type: Boolean, default: false },
    agencyWorkspace: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace" },

    onboardingCompleted: { type: Boolean, default: false },
    onboardingStep: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  },
);

// Generate slug from name
workspaceSchema.pre("save", async function (next) {
  if (this.isNew && !this.slug) {
    const base = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 30);
    const random = Math.random().toString(36).slice(2, 7);
    this.slug = `${base}-${random}`;
  }
  next();
});

// Plan limits
workspaceSchema.methods.getPlanLimits = function () {
  const limits = {
    starter: { messages: 500, contacts: 50, flows: 3, numbers: 1 },
    growth: { messages: 5000, contacts: 500, flows: Infinity, numbers: 1 },
    business: {
      messages: 20000,
      contacts: Infinity,
      flows: Infinity,
      numbers: 3,
    },
    agency: {
      messages: 50000,
      contacts: Infinity,
      flows: Infinity,
      numbers: 10,
    },
  };
  return limits[this.subscription.plan] || limits.starter;
};

module.exports = mongoose.model("Workspace", workspaceSchema);
