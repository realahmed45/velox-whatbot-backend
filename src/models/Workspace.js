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
    // IG Business Account ID (returned by /me as `id`, used in webhook entry.id).
    // Different from igUserId/IGSID returned by token exchange.
    igBusinessAccountId: { type: String, select: false },
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
    // Botlify Cloud (white-label hosted IG provider) — encrypted account id
    botlifyAccountId: { type: String, select: false },
    botlifyProfileId: { type: String, select: false },
    connectionType: {
      type: String,
      enum: ["meta_oauth", "session_cookie", "botlify_oauth"],
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

    // AI provider settings
    aiSettings: {
      provider: {
        type: String,
        enum: ["groq", "openai", "gemini", "none"],
        default: "groq",
      },
      model: { type: String, default: "llama-3.3-70b-versatile" },
      systemPrompt: {
        type: String,
        default:
          "You are a friendly, professional assistant. Keep replies short, warm, and helpful.",
      },
      businessContext: { type: String, default: "" },
      faqs: [
        {
          question: String,
          answer: String,
        },
      ],
      temperature: { type: Number, default: 0.4 },
      maxTokens: { type: Number, default: 240 },
      enabled: { type: Boolean, default: true },
      handoffKeywords: {
        type: [String],
        default: ["human", "agent", "support"],
      },

      // What the bot should focus on (drives prompt behaviour).
      // support | sales | leads | bookings | traffic
      goals: { type: [String], default: ["support"] },
      // Reply in the same language the follower used.
      matchLanguage: { type: Boolean, default: true },
      // Politely collect name + email/phone when a lead shows interest.
      leadCapture: { type: Boolean, default: false },
      // End replies with a light question/CTA to keep the conversation going.
      engageBack: { type: Boolean, default: false },
      // Optional link the bot can share (booking page, shop, link-in-bio).
      ctaLink: { type: String, default: "" },
    },

    // Lightweight AI bot analytics (reset monthly) so creators see the value.
    aiStats: {
      repliesThisMonth: { type: Number, default: 0 },
      faqHits: { type: Number, default: 0 },
      handoffs: { type: Number, default: 0 },
      leadsCaptured: { type: Number, default: 0 },
      lastReplyAt: Date,
      monthlyResetAt: Date,
    },

    // Subscription
    subscription: {
      plan: {
        type: String,
        enum: [
          "free",
          "ig_starter",
          "ig_pro",
          // legacy
          "starter",
          "growth",
          "scale",
          "business",
          "agency",
        ],
        default: "free",
      },
      status: {
        type: String,
        enum: ["trialing", "active", "suspended", "cancelled", "past_due"],
        default: "trialing",
      },
      currentPeriodStart: Date,
      currentPeriodEnd: Date,
      trialEndsAt: Date,
      activatedAt: Date,
      cancelAtPeriodEnd: { type: Boolean, default: false },
      billingCycleAnchor: Date,
    },

    // Usage tracking (resets monthly)
    usage: {
      messagesThisMonth: { type: Number, default: 0 },
      messagesLimit: { type: Number, default: 500 },
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
        scopes: {
          products: { type: Boolean, default: false },
          orders: { type: Boolean, default: false },
        },
        scopesCheckedAt: Date,
        authMethod: { type: String, enum: ["oauth", "manual"], default: "manual" },
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

    // Activation checklist — drives the "Get Started" card on dashboard
    activation: {
      welcomeSet: { type: Boolean, default: false },
      keywordsSet: { type: Boolean, default: false },
      contactsImported: { type: Boolean, default: false },
      testSent: { type: Boolean, default: false },
      dismissed: { type: Boolean, default: false },
    },

    // AI Knowledge Base — the bot's "training" material.
    //  - `content`  : free-form notes the creator types in.
    //  - `sources[]`: imported knowledge (website, products, etc.) each kept
    //                 separately so the creator can re-sync / remove one.
    aiKnowledge: {
      enabled: { type: Boolean, default: true },
      content: { type: String, default: "", maxlength: 12000 },
      sources: [
        {
          type: {
            type: String,
            enum: ["website", "text", "products", "shopify", "image"],
            default: "website",
          },
          label: { type: String, default: "" },
          url: { type: String, default: "" },
          imageUrl: { type: String, default: "" },
          content: { type: String, default: "", maxlength: 16000 },
          status: {
            type: String,
            enum: ["ready", "processing", "error"],
            default: "ready",
          },
          error: { type: String, default: "" },
          charCount: { type: Number, default: 0 },
          addedAt: { type: Date, default: Date.now },
          syncedAt: Date,
        },
      ],
      lastUpdatedAt: Date,
    },

    // Smart Orders — AI captures orders from chat, no payments
    smartOrders: {
      enabled: { type: Boolean, default: false },
      catalog: { type: String, default: "", maxlength: 5000 },
      paymentInstructions: { type: String, default: "", maxlength: 1000 },
      // Optional WhatsApp number to ping the merchant on new orders + daily digest
      notifyPhone: { type: String, default: "" },
      monthlyOrderCount: { type: Number, default: 0 },
      monthlyResetAt: Date,
      lastUpdatedAt: Date,
    },
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

// Plan limits — sourced from src/config/plans.js (single source of truth)
workspaceSchema.methods.getPlanLimits = function () {
  const { getPlan } = require("../config/plans");
  const plan = getPlan(this.subscription?.plan);
  const l = plan.limits || {};
  const norm = (n) => (n === -1 || n === undefined ? Infinity : n);
  return {
    messages: norm(l.messages),
    contacts: norm(l.contacts),
    flows: norm(l.flows),
    numbers: norm(l.numbers ?? 0),
    teamSeats: norm(l.teamSeats ?? 1),
    aiRepliesPerDay: norm(l.aiRepliesPerDay ?? 0),
    planId: plan.id,
    channel: plan.channel,
  };
};

module.exports = mongoose.model("Workspace", workspaceSchema);
