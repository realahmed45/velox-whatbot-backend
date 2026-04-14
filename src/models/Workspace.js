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

const whatsappConnectionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["ultramsg", "meta", "none"], default: "none" },
    status: {
      type: String,
      enum: ["connected", "disconnected", "scanning", "error"],
      default: "disconnected",
    },
    phoneNumber: String,
    displayName: String,
    // UltraMsg fields (encrypted at rest)
    ultralmsgInstanceId: { type: String, select: false },
    ultramsgToken: { type: String, select: false },
    // Meta Cloud API fields (encrypted at rest)
    metaPhoneNumberId: { type: String, select: false },
    metaWabaId: { type: String, select: false },
    metaAccessToken: { type: String, select: false },
    connectedAt: Date,
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

    // WhatsApp connection
    whatsapp: whatsappConnectionSchema,

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
      botEnabled: { type: Boolean, default: true },
      outsideHoursMessage: {
        type: String,
        default:
          "We are closed right now. Our business hours are Mon-Fri 9AM-6PM. We will get back to you soon!",
      },
      welcomeMessage: String,
      veloxBrandingEnabled: { type: Boolean, default: true },
      notifyOnNewLead: { type: Boolean, default: true },
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
