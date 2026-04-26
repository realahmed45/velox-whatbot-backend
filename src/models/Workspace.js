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
    webhookSubscribed: { type: Boolean, default: false },
    webhookError: { type: String, default: null },
    lastWebhookAt: { type: Date, default: null },
    lastWebhookType: { type: String, default: null },
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
        enum: ["starter", "growth", "scale", "business", "agency"],
        default: "starter",
      },
      status: {
        type: String,
        enum: ["active", "suspended", "cancelled", "past_due"],
        default: "active",
      },
      currentPeriodStart: Date,
      currentPeriodEnd: Date,
      activatedAt: Date,
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
      minDelayMinutes: { type: Number, default: 3 },
      maxDelayMinutes: { type: Number, default: 15 },
      activeHourStart: { type: Number, default: 0 },
      activeHourEnd: { type: Number, default: 23 },
      quietSunday: { type: Boolean, default: false },
      botlifyBrandingEnabled: { type: Boolean, default: true },
      notifyOnNewFollower: { type: Boolean, default: true },
      usageAlerts: { type: Boolean, default: true },
      businessHoursEnabled: { type: Boolean, default: false },
      averageOrderValue: { type: Number, default: 25 },
    },

    // DM Automation messages
    dmMessages: {
      enabled: { type: Boolean, default: true },
      greeting: {
        type: String,
        default:
          "Hey {name}! 👋 Thanks for following — really appreciate the support! Feel free to DM me anytime.",
      },
      followUp1: {
        type: String,
        default:
          "Hey {name}, just checking in! 😊 Let me know if you have any questions.",
      },
      followUp2: {
        type: String,
        default:
          "Hi {name}! Wanted to make sure you saw my last message. Happy to help with anything!",
      },
      followUp3: {
        type: String,
        default:
          "Hey {name}, last message from me — just know I'm here whenever you're ready! 🙌",
      },
      followUpIntervalHours: { type: Number, default: 3 },
    },

    // Keyword triggers — when someone comments a keyword, auto-DM them
    // Each entry: { keyword: "DM", replyMessage: "Hey! Here's the info...", enabled: true }
    keywordTriggers: [
      {
        keyword: { type: String, required: true, trim: true },
        replyMessage: { type: String, required: true },
        enabled: { type: Boolean, default: true },
        matchType: {
          type: String,
          enum: ["contains", "exact"],
          default: "contains",
        },
        // Optional: attach Call-to-Action button to the DM
        ctaLabel: String,
        ctaUrl: String,
      },
    ],

    // DM keyword triggers — when user DMs a keyword, auto-reply
    dmKeywordTriggers: [
      {
        keyword: { type: String, required: true, trim: true },
        replyMessage: { type: String, required: true },
        enabled: { type: Boolean, default: true },
        matchType: {
          type: String,
          enum: ["contains", "exact"],
          default: "contains",
        },
        ctaLabel: String,
        ctaUrl: String,
      },
    ],

    // Story-reply trigger — when someone replies to your story
    storyReplyTrigger: {
      enabled: { type: Boolean, default: false },
      replyMessage: {
        type: String,
        default:
          "Thanks for replying to my story {name}! 💙 Got something cool for you — just DM 'INFO' to get details.",
      },
      // Optional per-keyword routing
      keywords: [
        {
          keyword: String,
          replyMessage: String,
          matchType: {
            type: String,
            enum: ["contains", "exact"],
            default: "contains",
          },
        },
      ],
    },

    // Story-mention trigger — when someone @mentions you in their story
    storyMentionTrigger: {
      enabled: { type: Boolean, default: false },
      replyMessage: {
        type: String,
        default:
          "Omg {name}, thanks so much for the mention! 🥹 Love it. DM me anytime!",
      },
    },

    // Share-to-story / share-to-DM — when someone shares your post or DMs you a share
    shareToStoryTrigger: {
      enabled: { type: Boolean, default: false },
      replyMessage: {
        type: String,
        default:
          "Thanks for sharing {name}! 💙 That means a lot. Here's something for you — DM 'MORE' to unlock.",
      },
    },

    // Live-comment trigger — keyword auto-reply on live-stream comments
    liveCommentTriggers: [
      {
        keyword: String,
        replyMessage: String,
        enabled: { type: Boolean, default: true },
      },
    ],

    // Ref-URL triggers — deep links (ig.me/m/username?ref=CODE) → custom welcome
    refUrlTriggers: [
      {
        code: { type: String, required: true, trim: true },
        label: String,
        replyMessage: { type: String, required: true },
        enabled: { type: Boolean, default: true },
      },
    ],

    // Ice-breakers / conversation starters
    conversationStarters: {
      enabled: { type: Boolean, default: false },
      greeting: {
        type: String,
        default: "👋 Hi! How can I help you today?",
      },
      options: [
        {
          label: String, // shown as quick-reply button
          payload: String, // internal id
          replyMessage: String,
        },
      ],
    },

    // Global fallback auto-reply — matches nothing else
    fallbackReply: {
      enabled: { type: Boolean, default: true },
      message: {
        type: String,
        default:
          "Hey {name}! 👋 Thanks for the message. A human will get back to you shortly.",
      },
      cooldownHours: { type: Number, default: 24 },
    },

    // Business-hours auto-reply (sent when outside hours)
    awayReply: {
      enabled: { type: Boolean, default: false },
      message: {
        type: String,
        default:
          "Thanks for reaching out {name}! 🌙 We're away right now but will get back to you within business hours.",
      },
    },

    // AI Conversational Bot (Scale/Premium plan only)
    aiBot: {
      enabled: { type: Boolean, default: false },
      personality: {
        type: String,
        default:
          "You are a friendly, professional assistant for our Instagram business. Be concise, warm, and helpful. Keep replies under 2 sentences when possible. Use emojis sparingly.",
      },
      businessInfo: {
        type: String,
        default: "",
      },
      model: { type: String, default: "gpt-4o-mini" },
      maxTurnsPerConversation: { type: Number, default: 20 },
      escalateOnKeywords: {
        type: [String],
        default: ["human", "agent", "support", "help"],
      },
    },

    // Hide negative comments — auto-moderation on post comments
    hideNegativeComments: {
      enabled: { type: Boolean, default: false },
      mode: {
        type: String,
        enum: ["profanity_only", "profanity_and_toxic", "all_flagged"],
        default: "profanity_and_toxic",
      },
      blockedWords: [{ type: String, lowercase: true, trim: true }],
      competitorNames: [{ type: String, lowercase: true, trim: true }],
      hiddenCount: { type: Number, default: 0 },
    },

    // VIP Comment Prioritizer (B4) — flag comments from watched usernames
    vipComments: {
      enabled: { type: Boolean, default: false },
      usernames: [{ type: String, lowercase: true, trim: true }],
      autoDmTemplate: {
        type: String,
        default: "",
      },
      flaggedCount: { type: Number, default: 0 },
    },

    // Sentiment tagging on inbound messages
    sentimentAnalysis: {
      enabled: { type: Boolean, default: false },
      autoFlagAngry: { type: Boolean, default: true },
    },

    // UI language preference — applies to agent dashboard
    language: {
      type: String,
      enum: ["en", "ur", "ar", "es", "fr", "hi"],
      default: "en",
    },

    // White-label branding (F11)
    branding: {
      customDomain: { type: String, default: null },
      brandName: { type: String, default: null },
      logoUrl: { type: String, default: null },
      primaryColor: { type: String, default: null },
      hideBotlify: { type: Boolean, default: false },
    },

    // Follower history snapshots (polled every 6h since IG has no follow webhook)
    followerHistory: [
      {
        count: Number,
        at: { type: Date, default: Date.now },
      },
    ],

    // Third-party integrations
    integrations: {
      shopify: {
        storeUrl: String,
        accessToken: { type: String, select: false },
        connectedAt: Date,
        productCount: { type: Number, default: 0 },
      },
      mailchimp: {
        apiKey: { type: String, select: false },
        listId: String,
        serverPrefix: String, // e.g. "us1"
        connectedAt: Date,
      },
    },

    // Referral program (G8)
    referral: {
      code: { type: String, unique: true, sparse: true, index: true },
      referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace" },
      signups: { type: Number, default: 0 },
      paidConversions: { type: Number, default: 0 },
      creditsEarned: { type: Number, default: 0 },
      creditsAvailable: { type: Number, default: 0 },
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
  if (this.isNew && !this.referral?.code) {
    const code =
      "BOT" +
      Math.random()
        .toString(36)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6);
    this.referral = { ...(this.referral || {}), code };
  }
  next();
});

// Plan limits
workspaceSchema.methods.getPlanLimits = function () {
  const limits = {
    starter: { messages: 500, contacts: 50, flows: 3, numbers: 1 },
    growth: { messages: 5000, contacts: 500, flows: Infinity, numbers: 1 },
    scale: {
      messages: Infinity,
      contacts: Infinity,
      flows: Infinity,
      numbers: 3,
    },
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
