/**
 * Botlify — Plan catalog (source of truth)
 *
 * HOTEL pivot: Botlify is an AI booking system for hotels.
 * Two plans:
 *   - hotel_free : $0 — full product, used during the launch/testing phase.
 *                  Will be removed once the paid flow is fully validated.
 *   - hotel_pro  : $49/mo — the real service fee. 3-day trial, card upfront
 *                  (trial configured on the Creem product).
 *
 * For now BOTH plans grant identical features/limits by design — the only
 * difference is billing. Booking commissions (10% on bot-closed bookings) are
 * tracked in the commission ledger, not gated here.
 */

const FEATURES = {
  // Messaging channels
  CHANNEL_INSTAGRAM: "channel_instagram",
  CHANNEL_WHATSAPP: "channel_whatsapp",
  // TikTok: posting/analytics only — the provider has no TikTok DM API, so it
  // cannot carry the concierge. Kept for a future posting feature.
  CHANNEL_TIKTOK: "channel_tiktok",
  // Hotel core
  HOTEL_BOOKINGS: "hotel_bookings", // multi-night stay booking engine
  OTA_SYNC: "ota_sync", // Booking.com/Airbnb via Channex (free sync — the hook)
  TRANSFERS: "transfers", // airport pickup/dropoff
  // AI + inbox
  AI_BOT: "ai_bot",
  AI_PREMIUM: "ai_premium",
  TEAM_INBOX: "team_inbox",
  BUSINESS_HOURS: "business_hours",
  FALLBACK_AUTO_REPLY: "fallback_auto_reply",
  CONVERSATION_STARTERS: "conversation_starters",
  // Marketing extras kept from the IG product (still useful for hotels)
  POST_COMMENT_KEYWORD: "post_comment_keyword",
  DM_KEYWORD: "dm_keyword",
  WELCOME_DM: "welcome_dm",
  STORY_REPLY: "story_reply",
  STORY_MENTION: "story_mention",
  SHARE_TO_STORY: "share_to_story",
  REF_URL: "ref_url",
  LIVE_COMMENT: "live_comment",
  BROADCAST: "broadcast",
  DRIP_CAMPAIGNS: "drip_campaigns",
  ANALYTICS_ADVANCED: "analytics_advanced",
  REMOVE_BRANDING: "remove_branding",
  CUSTOM_DOMAIN: "custom_domain",
  // Legacy (kept so old plan records resolve; no hotel plan grants it)
  SMART_ORDERS: "smart_orders",
};

// Every feature the hotel product ships. Both plans get all of it for now —
// once the free plan is retired, this list simply lives on hotel_pro.
const hotelFeatures = [
  FEATURES.CHANNEL_INSTAGRAM,
  FEATURES.CHANNEL_WHATSAPP,
  FEATURES.CHANNEL_TIKTOK,
  FEATURES.HOTEL_BOOKINGS,
  FEATURES.OTA_SYNC,
  FEATURES.TRANSFERS,
  FEATURES.AI_BOT,
  FEATURES.AI_PREMIUM,
  FEATURES.TEAM_INBOX,
  FEATURES.BUSINESS_HOURS,
  FEATURES.FALLBACK_AUTO_REPLY,
  FEATURES.CONVERSATION_STARTERS,
  FEATURES.POST_COMMENT_KEYWORD,
  FEATURES.DM_KEYWORD,
  FEATURES.WELCOME_DM,
  FEATURES.STORY_REPLY,
  FEATURES.STORY_MENTION,
  FEATURES.SHARE_TO_STORY,
  FEATURES.REF_URL,
  FEATURES.LIVE_COMMENT,
  FEATURES.BROADCAST,
  FEATURES.DRIP_CAMPAIGNS,
  FEATURES.ANALYTICS_ADVANCED,
];

const hotelLimits = {
  messages: -1,
  contacts: -1,
  flows: -1,
  teamSeats: 5,
  aiRepliesPerDay: -1,
  properties: 3,
  smartOrdersPerMonth: 0,
};

const PLANS = {
  // ─── "free" = NO active subscription ────────────────────
  // A workspace that hasn't picked a plan yet (or whose subscription ended).
  // Grants nothing; the app paywalls until a plan is chosen.
  free: {
    id: "free",
    name: "No plan",
    tagline: "Choose a plan to unlock Botlify",
    channel: "all",
    priceMonthly: 0,
    priceAnnual: 0,
    currency: "USD",
    usd: 0,
    trialDays: 3,
    limits: {
      messages: 0,
      contacts: 0,
      flows: 0,
      teamSeats: 1,
      aiRepliesPerDay: 0,
      properties: 0,
      smartOrdersPerMonth: 0,
    },
    features: [],
    highlights: ["Choose a plan to get started"],
  },

  // ─── Hotel plans ────────────────────────────────────────
  hotel_free: {
    id: "hotel_free",
    name: "Launch (Free)",
    tagline: "Full access while we launch — no card needed",
    channel: "all",
    priceMonthly: 0,
    priceAnnual: 0,
    currency: "USD",
    usd: 0,
    trialDays: 0,
    limits: { ...hotelLimits },
    features: [...hotelFeatures],
    highlights: [
      "Booking.com + Airbnb sync (free)",
      "AI concierge on WhatsApp & Instagram",
      "Bot books rooms & reservations 24/7",
      "Airport pickup & drop-off for guests",
      "Unified inbox with human takeover",
    ],
  },
  hotel_pro: {
    id: "hotel_pro",
    name: "Botlify for Hotels",
    tagline: "Everything your hotel needs to take bookings on autopilot",
    channel: "all",
    priceMonthly: 49,
    priceAnnual: 49 * 10, // 2 months free
    currency: "USD",
    usd: 49,
    trialDays: 3,
    recommended: true,
    limits: { ...hotelLimits },
    features: [...hotelFeatures],
    highlights: [
      "Booking.com + Airbnb sync (free, 0% commission)",
      "AI concierge on WhatsApp & Instagram",
      "Bot books rooms & reservations 24/7",
      "Airport pickup & drop-off for guests",
      "Unified inbox with human takeover",
      "Only 10% on bookings the bot closes for you",
    ],
  },
};

// ─── Legacy plan key aliases (back-compat for older subscriptions) ──
// Old Instagram-era customers keep full access on the hotel product.
const LEGACY_ALIASES = {
  starter: "free",
  growth: "hotel_pro",
  scale: "hotel_pro",
  business: "hotel_pro",
  agency: "hotel_pro",
  ig_starter: "hotel_pro",
  ig_pro: "hotel_pro",
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

const SUPPORTED_CHANNELS = ["instagram", "whatsapp", "tiktok"];
const planSupportsChannel = (planId, channel) => {
  if (!SUPPORTED_CHANNELS.includes(channel)) return false;
  return planHasFeature(planId, `channel_${channel}`);
};

const PLAN_KEYS_FOR_ENUM = [
  "free",
  "hotel_free",
  "hotel_pro",
  // legacy
  "ig_starter",
  "ig_pro",
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

const PLAN_USD_PRICES = {
  free: { monthly: 0, annual: 0 },
  hotel_free: { monthly: 0, annual: 0 },
  hotel_pro: { monthly: 49, annual: 490 },
  // legacy — kept so old webhook events still resolve an amount
  ig_starter: { monthly: 9, annual: 90 },
  ig_pro: { monthly: 19, annual: 190 },
};

// Commission the platform takes on bookings the BOT closes (social/direct).
// OTA-originated bookings (Booking.com/Airbnb) are always 0% — that's the deal.
const SOCIAL_BOOKING_COMMISSION_RATE = 0.10;
// Consultants earn this share of Botlify's revenue from hotels they signed,
// for CONSULTANT_SHARE_MONTHS after attribution.
const CONSULTANT_REVENUE_SHARE_RATE = 0.20;
const CONSULTANT_SHARE_MONTHS = 12;

module.exports = {
  PLANS,
  FEATURES,
  LEGACY_ALIASES,
  PLAN_KEYS_FOR_ENUM,
  PLAN_PRICES,
  PLAN_USD_PRICES,
  SUPPORTED_CHANNELS,
  SOCIAL_BOOKING_COMMISSION_RATE,
  CONSULTANT_REVENUE_SHARE_RATE,
  CONSULTANT_SHARE_MONTHS,
  resolvePlanId,
  getPlan,
  planHasFeature,
  planSupportsChannel,
};
