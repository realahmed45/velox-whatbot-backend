/**
 * Botlify — Plan catalog (source of truth)
 *
 * Dual-channel pricing model:
 *   • Instagram-only plans   (zero infra COGS once Meta-approved)
 *   • WhatsApp-only plans    (Botlify Cloud per-number cost)
 *   • Bundle plans           (best margin — push these)
 *
 * Pricing in PKR (primary) with USD reference. 7-day free trial on every paid plan.
 *
 * Channel codes used elsewhere in the app:
 *   - "instagram"   → IG features
 *   - "whatsapp"    → WA features
 *   - "both"        → bundle
 */

const FEATURES = {
  // IG / shared
  POST_COMMENT_KEYWORD: "post_comment_keyword",
  DM_KEYWORD: "dm_keyword",
  WELCOME_DM: "welcome_dm",
  STORY_REPLY: "story_reply",
  STORY_MENTION: "story_mention",
  SHARE_TO_STORY: "share_to_story",
  REF_URL: "ref_url",
  LIVE_COMMENT: "live_comment",
  CONVERSATION_STARTERS: "conversation_starters",
  FALLBACK_AUTO_REPLY: "fallback_auto_reply",
  BUSINESS_HOURS: "business_hours",
  // AI
  AI_BOT: "ai_bot",
  AI_PREMIUM: "ai_premium",
  // WA
  WA_QUICK_CONNECT: "wa_quick_connect",
  WA_OFFICIAL_API: "wa_official_api",
  WA_BROADCASTS: "wa_broadcasts",
  WA_DRIP: "wa_drip",
  // Engagement
  BROADCAST: "broadcast",
  DRIP_CAMPAIGNS: "drip_campaigns",
  ANALYTICS_ADVANCED: "analytics_advanced",
  TEAM_INBOX: "team_inbox",
  REMOVE_BRANDING: "remove_branding",
  CUSTOM_DOMAIN: "custom_domain",
};

// PKR ↔ USD reference (display only)
const USD = (pkr) => Math.round(pkr / 280);

const baseIgFeatures = [
  FEATURES.POST_COMMENT_KEYWORD,
  FEATURES.DM_KEYWORD,
  FEATURES.WELCOME_DM,
  FEATURES.STORY_REPLY,
  FEATURES.STORY_MENTION,
  FEATURES.SHARE_TO_STORY,
  FEATURES.REF_URL,
  FEATURES.LIVE_COMMENT,
  FEATURES.CONVERSATION_STARTERS,
  FEATURES.FALLBACK_AUTO_REPLY,
];

const baseWaFeatures = [
  FEATURES.WA_QUICK_CONNECT,
  FEATURES.DM_KEYWORD,
  FEATURES.WELCOME_DM,
  FEATURES.FALLBACK_AUTO_REPLY,
  FEATURES.BUSINESS_HOURS,
];

const PLANS = {
  // ─── Free trial / fallback ──────────────────────────────
  free: {
    id: "free",
    name: "Free trial",
    tagline: "7 days free — no card required",
    channel: "both",
    priceMonthly: 0,
    priceAnnual: 0,
    currency: "PKR",
    usd: 0,
    trialDays: 7,
    limits: {
      messages: 100,
      contacts: 50,
      flows: 1,
      numbers: 0, // cannot connect a real WA number on free
      teamSeats: 1,
      aiRepliesPerDay: 25,
    },
    features: [
      FEATURES.POST_COMMENT_KEYWORD,
      FEATURES.DM_KEYWORD,
      FEATURES.WELCOME_DM,
      FEATURES.AI_BOT,
    ],
    highlights: [
      "Try every feature free for 7 days",
      "Connect Instagram (full access)",
      "WhatsApp demo mode (no live number)",
      "AI replies — 25/day",
      "Botlify branding",
    ],
  },

  // ─── Instagram plans ────────────────────────────────────
  ig_starter: {
    id: "ig_starter",
    name: "Instagram Starter",
    tagline: "Comment-to-DM + AI replies",
    channel: "instagram",
    priceMonthly: 2499,
    priceAnnual: 2499 * 10, // 2 months free
    currency: "PKR",
    usd: 9,
    limits: {
      messages: 1000,
      contacts: 500,
      flows: 5,
      teamSeats: 1,
      aiRepliesPerDay: 200,
    },
    features: [
      ...baseIgFeatures,
      FEATURES.AI_BOT,
      FEATURES.BUSINESS_HOURS,
    ],
    highlights: [
      "1,000 conversations/month",
      "500 contacts",
      "Comment → DM, story replies, ice breakers",
      "Standard AI replies (200/day)",
      "Basic analytics",
    ],
  },
  ig_pro: {
    id: "ig_pro",
    name: "Instagram Pro",
    tagline: "Unlimited convos + premium AI",
    channel: "instagram",
    priceMonthly: 5499,
    priceAnnual: 5499 * 10,
    currency: "PKR",
    usd: 19,
    limits: {
      messages: -1,
      contacts: -1,
      flows: -1,
      teamSeats: 3,
      aiRepliesPerDay: -1,
    },
    features: [
      ...baseIgFeatures,
      FEATURES.AI_BOT,
      FEATURES.AI_PREMIUM,
      FEATURES.BUSINESS_HOURS,
      FEATURES.BROADCAST,
      FEATURES.DRIP_CAMPAIGNS,
      FEATURES.ANALYTICS_ADVANCED,
      FEATURES.TEAM_INBOX,
      FEATURES.REMOVE_BRANDING,
    ],
    highlights: [
      "Unlimited conversations",
      "Unlimited contacts",
      "Premium AI · context-aware",
      "Broadcasts + drip campaigns",
      "Advanced analytics",
      "Team inbox (3 seats)",
      "Remove Botlify branding",
    ],
  },

  // ─── WhatsApp plans ─────────────────────────────────────
  wa_starter: {
    id: "wa_starter",
    name: "WhatsApp Starter",
    tagline: "Your WhatsApp on autopilot",
    channel: "whatsapp",
    priceMonthly: 4499,
    priceAnnual: 4499 * 10,
    currency: "PKR",
    usd: 17,
    limits: {
      messages: 1000,
      contacts: 1000,
      flows: 5,
      numbers: 1,
      teamSeats: 1,
      aiRepliesPerDay: 200,
    },
    features: [
      ...baseWaFeatures,
      FEATURES.AI_BOT,
    ],
    highlights: [
      "1 WhatsApp number (Quick Connect)",
      "1,000 messages / month",
      "1,000 contacts",
      "AI auto-replies (200/day)",
      "Welcome message, keyword triggers",
      "Out-of-hours auto-reply",
    ],
  },
  wa_pro: {
    id: "wa_pro",
    name: "WhatsApp Pro",
    tagline: "Unlimited messaging + broadcasts",
    channel: "whatsapp",
    priceMonthly: 5499,
    priceAnnual: 5499 * 10,
    currency: "PKR",
    usd: 19,
    limits: {
      messages: -1,
      contacts: -1,
      flows: -1,
      numbers: 1,
      teamSeats: 3,
      aiRepliesPerDay: -1,
    },
    features: [
      ...baseWaFeatures,
      FEATURES.WA_OFFICIAL_API,
      FEATURES.AI_BOT,
      FEATURES.AI_PREMIUM,
      FEATURES.WA_BROADCASTS,
      FEATURES.WA_DRIP,
      FEATURES.BROADCAST,
      FEATURES.DRIP_CAMPAIGNS,
      FEATURES.ANALYTICS_ADVANCED,
      FEATURES.TEAM_INBOX,
      FEATURES.REMOVE_BRANDING,
    ],
    highlights: [
      "1 WhatsApp number",
      "Unlimited messages & contacts",
      "Premium AI · context-aware",
      "Broadcast campaigns",
      "Drip / scheduled flows",
      "Team inbox (3 seats)",
      "Advanced analytics",
      "Remove Botlify branding",
    ],
  },

  // ─── Bundle (push hardest — best margin) ────────────────
  bundle_pro: {
    id: "bundle_pro",
    name: "Both Channels Pro",
    tagline: "Instagram + WhatsApp · best value",
    channel: "both",
    priceMonthly: 7999,
    priceAnnual: 7999 * 10,
    currency: "PKR",
    usd: 29,
    limits: {
      messages: -1,
      contacts: -1,
      flows: -1,
      numbers: 1,
      teamSeats: 3,
      aiRepliesPerDay: -1,
    },
    features: [
      ...baseIgFeatures,
      ...baseWaFeatures,
      FEATURES.AI_BOT,
      FEATURES.AI_PREMIUM,
      FEATURES.WA_BROADCASTS,
      FEATURES.WA_DRIP,
      FEATURES.BROADCAST,
      FEATURES.DRIP_CAMPAIGNS,
      FEATURES.ANALYTICS_ADVANCED,
      FEATURES.TEAM_INBOX,
      FEATURES.REMOVE_BRANDING,
    ],
    highlights: [
      "Everything in IG Pro + WA Pro",
      "1 WhatsApp number",
      "Unlimited messages on both channels",
      "Premium AI on both channels",
      "Broadcasts + drip on both",
      "Team inbox (3 seats)",
      "Save vs buying separately",
    ],
    recommended: true,
  },
  bundle_business: {
    id: "bundle_business",
    name: "Both Channels Business",
    tagline: "For growing teams · 2 numbers, 10 seats",
    channel: "both",
    priceMonthly: 13999,
    priceAnnual: 13999 * 10,
    currency: "PKR",
    usd: 49,
    limits: {
      messages: -1,
      contacts: -1,
      flows: -1,
      numbers: 2,
      teamSeats: 10,
      aiRepliesPerDay: -1,
    },
    features: [
      ...baseIgFeatures,
      ...baseWaFeatures,
      FEATURES.AI_BOT,
      FEATURES.AI_PREMIUM,
      FEATURES.WA_BROADCASTS,
      FEATURES.WA_DRIP,
      FEATURES.WA_OFFICIAL_API,
      FEATURES.BROADCAST,
      FEATURES.DRIP_CAMPAIGNS,
      FEATURES.ANALYTICS_ADVANCED,
      FEATURES.TEAM_INBOX,
      FEATURES.REMOVE_BRANDING,
      FEATURES.CUSTOM_DOMAIN,
    ],
    highlights: [
      "Everything in Both Channels Pro",
      "2 WhatsApp numbers",
      "Team inbox (10 seats)",
      "Custom domain / white-label option",
      "Priority support",
    ],
    premium: true,
  },
};

// ─── Legacy plan key aliases (back-compat for older subscriptions) ──
const LEGACY_ALIASES = {
  starter: "free",
  growth: "ig_starter",
  scale: "ig_pro",
  business: "bundle_pro",
  agency: "bundle_business",
};

const resolvePlanId = (planId) => {
  if (!planId) return "free";
  if (PLANS[planId]) return planId;
  if (LEGACY_ALIASES[planId]) return LEGACY_ALIASES[planId];
  return "free";
};

const getPlan = (planId) => PLANS[resolvePlanId(planId)];

const planHasFeature = (planId, feature) => {
  const p = getPlan(planId);
  return !!p && p.features.includes(feature);
};

const planSupportsChannel = (planId, channel) => {
  const p = getPlan(planId);
  if (!p) return false;
  if (p.channel === "both") return true;
  return p.channel === channel;
};

const planAllowsWhatsAppLiveNumber = (planId) => {
  const p = getPlan(planId);
  if (!p) return false;
  return (p.limits?.numbers || 0) > 0 && planSupportsChannel(p.id, "whatsapp");
};

const PLAN_KEYS_FOR_ENUM = [
  "free",
  "ig_starter",
  "ig_pro",
  "wa_starter",
  "wa_pro",
  "bundle_pro",
  "bundle_business",
  // legacy
  "starter",
  "growth",
  "scale",
  "business",
  "agency",
];

const PLAN_PRICES = Object.fromEntries(
  Object.values(PLANS).map((p) => [
    p.id,
    { monthly: p.priceMonthly, annual: p.priceAnnual },
  ]),
);

module.exports = {
  PLANS,
  FEATURES,
  LEGACY_ALIASES,
  PLAN_KEYS_FOR_ENUM,
  PLAN_PRICES,
  USD,
  resolvePlanId,
  getPlan,
  planHasFeature,
  planSupportsChannel,
  planAllowsWhatsAppLiveNumber,
};
