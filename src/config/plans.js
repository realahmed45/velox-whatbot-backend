/**
 * Botlify — Plan catalog (source of truth)
 *
 * Instagram-only pricing model.
 * Pricing in PKR (primary) with USD reference. 3-day free trial on every paid plan.
 */

const FEATURES = {
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
  AI_BOT: "ai_bot",
  AI_PREMIUM: "ai_premium",
  BROADCAST: "broadcast",
  DRIP_CAMPAIGNS: "drip_campaigns",
  ANALYTICS_ADVANCED: "analytics_advanced",
  TEAM_INBOX: "team_inbox",
  REMOVE_BRANDING: "remove_branding",
  CUSTOM_DOMAIN: "custom_domain",
  SMART_ORDERS: "smart_orders",
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

const PLANS = {
  // ─── Free trial / fallback ──────────────────────────────
  free: {
    id: "free",
    name: "Free trial",
    tagline: "3 days free — then pick a plan",
    channel: "both",
    priceMonthly: 0,
    priceAnnual: 0,
    currency: "PKR",
    usd: 0,
    trialDays: 3,
    limits: {
      messages: 100,
      contacts: 50,
      flows: 1,
      teamSeats: 1,
      aiRepliesPerDay: 25,
      smartOrdersPerMonth: 5,
    },
    features: [
      FEATURES.POST_COMMENT_KEYWORD,
      FEATURES.DM_KEYWORD,
      FEATURES.WELCOME_DM,
      FEATURES.AI_BOT,
    ],
    highlights: [
      "Try every feature free for 3 days",
      "Connect Instagram (full access)",
      "AI replies — 25/day",
      "Botlify branding",
    ],
  },

  // ─── Instagram plans ────────────────────────────────────
  ig_starter: {
    id: "ig_starter",
    name: "Basic — Instagram",
    tagline: "Instagram only · automate DMs and comments",
    channel: "instagram",
    priceMonthly: 2240, // ≈ $8 @ 280 PKR/USD
    priceAnnual: 2240 * 10, // 2 months free
    currency: "PKR",
    usd: 8,
    trialDays: 3,
    limits: {
      messages: 1000,
      contacts: 1000,
      flows: 5,
      teamSeats: 1,
      aiRepliesPerDay: 200,
      smartOrdersPerMonth: 20,
    },
    features: [
      ...baseIgFeatures,
      FEATURES.AI_BOT,
      FEATURES.BUSINESS_HOURS,
      FEATURES.SMART_ORDERS,
    ],
    highlights: [
      "1 Instagram account",
      "1,000 conversations/month",
      "Comment → DM, story replies, ice breakers",
      "AI smart replies (200/day)",
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
      smartOrdersPerMonth: 200,
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
      FEATURES.SMART_ORDERS,
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

};

// ─── Legacy plan key aliases (back-compat for older subscriptions) ──
const LEGACY_ALIASES = {
  starter: "free",
  growth: "ig_starter",
  scale: "ig_pro",
  business: "ig_pro",
  agency: "ig_pro",
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

const planSupportsChannel = (_planId, channel) => channel === "instagram";

const PLAN_KEYS_FOR_ENUM = [
  "free",
  "ig_starter",
  "ig_pro",
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

// USD prices used for international card billing (Xendit). Annual = 10× monthly
// (2 months free), mirroring the PKR annual discount.
const PLAN_USD_PRICES = {
  free: { monthly: 0, annual: 0 },
  ig_starter: { monthly: 8, annual: 80 },
  ig_pro: { monthly: 19, annual: 190 },
};

module.exports = {
  PLANS,
  FEATURES,
  LEGACY_ALIASES,
  PLAN_KEYS_FOR_ENUM,
  PLAN_PRICES,
  PLAN_USD_PRICES,
  USD,
  resolvePlanId,
  getPlan,
  planHasFeature,
  planSupportsChannel,
};
