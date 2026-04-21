/**
 * Botlify — Plan catalog (source of truth)
 * Pricing in PKR. No payment gateway yet — click-to-activate.
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
  BROADCAST: "broadcast",
  ANALYTICS_ADVANCED: "analytics_advanced",
  TEAM_INBOX: "team_inbox",
  REMOVE_BRANDING: "remove_branding",
};

const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "Get started free",
    priceMonthly: 0,
    currency: "PKR",
    limits: {
      dmsPerMonth: 500,
      triggers: 5,
      teamSeats: 1,
    },
    features: [
      FEATURES.POST_COMMENT_KEYWORD,
      FEATURES.DM_KEYWORD,
      FEATURES.WELCOME_DM,
      FEATURES.FALLBACK_AUTO_REPLY,
    ],
    highlights: [
      "500 DMs / month",
      "Post-comment keyword triggers",
      "DM keyword replies",
      "Welcome DM on first message",
      "Fallback auto-reply",
      "Botlify branding",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    tagline: "Scale your engagement",
    priceMonthly: 2999,
    currency: "PKR",
    limits: {
      dmsPerMonth: 5000,
      triggers: 50,
      teamSeats: 3,
    },
    features: [
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
      FEATURES.BUSINESS_HOURS,
      FEATURES.BROADCAST,
      FEATURES.ANALYTICS_ADVANCED,
      FEATURES.TEAM_INBOX,
      FEATURES.REMOVE_BRANDING,
    ],
    highlights: [
      "5,000 DMs / month",
      "Everything in Starter",
      "Story reply & mention triggers",
      "Share-to-story → DM",
      "Live-comment auto-reply",
      "Ref-URL deep links",
      "Conversation starters & ice breakers",
      "Business-hours auto-reply",
      "Broadcast campaigns",
      "Advanced analytics",
      "Team inbox (3 seats)",
      "Remove Botlify branding",
    ],
    recommended: true,
  },
  scale: {
    id: "scale",
    name: "Scale",
    tagline: "Premium • AI conversational bot",
    priceMonthly: 9999,
    currency: "PKR",
    limits: {
      dmsPerMonth: -1, // unlimited
      triggers: -1,
      teamSeats: 10,
    },
    features: [
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
      FEATURES.BUSINESS_HOURS,
      FEATURES.AI_BOT,
      FEATURES.BROADCAST,
      FEATURES.ANALYTICS_ADVANCED,
      FEATURES.TEAM_INBOX,
      FEATURES.REMOVE_BRANDING,
    ],
    highlights: [
      "Unlimited DMs",
      "Everything in Growth",
      "🤖 AI conversational bot (GPT-powered)",
      "Context-aware replies that learn",
      "Priority processing",
      "Team inbox (10 seats)",
      "Priority support",
    ],
    premium: true,
  },
};

const planHasFeature = (planId, feature) => {
  const p = PLANS[planId] || PLANS.starter;
  return p.features.includes(feature);
};

const getPlan = (planId) => PLANS[planId] || PLANS.starter;

module.exports = { PLANS, FEATURES, planHasFeature, getPlan };
