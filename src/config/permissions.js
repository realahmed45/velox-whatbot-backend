/**
 * Agent permissions. Owners always have everything. Agents get only the
 * permission keys granted on their workspace member record.
 *
 * Each permission gates a dashboard area (sidebar item) and the API routes
 * behind it. Keep keys stable — they're stored on member/invite records.
 */

const PERMISSIONS = {
  INBOX: "inbox", // view + reply to conversations, take over, tag, resolve
  CONTACTS: "contacts", // view + manage contacts
  AUTOMATIONS: "automations", // AI bot, smart automations, custom flows
  BROADCASTS: "broadcasts", // broadcasts + drip campaigns
  CONTENT: "content", // scheduled posts + hashtags
  ANALYTICS: "analytics", // analytics dashboard
  INTEGRATIONS: "integrations", // apps + webhooks
  SETTINGS: "settings", // workspace settings
};

// UI-facing catalogue (label + description) so the invite modal can render it.
const PERMISSION_LIST = [
  { key: PERMISSIONS.INBOX, label: "Inbox", desc: "Reply to DMs, take over from the bot, tag & resolve" },
  { key: PERMISSIONS.CONTACTS, label: "Contacts", desc: "View and manage the contact list" },
  { key: PERMISSIONS.AUTOMATIONS, label: "Automations", desc: "AI Bot, Smart Automations & Custom Flows" },
  { key: PERMISSIONS.BROADCASTS, label: "Broadcasts & Drips", desc: "Send broadcasts and run drip campaigns" },
  { key: PERMISSIONS.CONTENT, label: "Content", desc: "Scheduled posts and hashtag research" },
  { key: PERMISSIONS.ANALYTICS, label: "Analytics", desc: "View performance analytics" },
  { key: PERMISSIONS.INTEGRATIONS, label: "Integrations", desc: "Apps and webhooks" },
  { key: PERMISSIONS.SETTINGS, label: "Settings", desc: "Change workspace settings" },
];

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// A sensible default when an owner invites without picking anything.
const DEFAULT_AGENT_PERMISSIONS = [PERMISSIONS.INBOX, PERMISSIONS.CONTACTS];

const isValidPermission = (p) => ALL_PERMISSIONS.includes(p);
const sanitizePermissions = (arr) =>
  Array.isArray(arr) ? [...new Set(arr.filter(isValidPermission))] : [];

module.exports = {
  PERMISSIONS,
  PERMISSION_LIST,
  ALL_PERMISSIONS,
  DEFAULT_AGENT_PERMISSIONS,
  isValidPermission,
  sanitizePermissions,
};
