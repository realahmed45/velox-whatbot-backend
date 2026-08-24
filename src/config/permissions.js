/**
 * Staff permissions. Owners always have everything. Staff get only the
 * permission keys granted on their workspace member record.
 *
 * Each permission gates a dashboard area and the API routes behind it. Keys are
 * STABLE — they're stored on member/invite records, so existing staff keep
 * working. Where a key's meaning shifted with the hotel pivot (e.g. "content"
 * used to mean scheduled Instagram posts) the label and description changed but
 * the key did not.
 */

const PERMISSIONS = {
  BOOKINGS: "bookings", // view + manage reservations, check in/out
  INBOX: "inbox", // reply to guests, take over from the AI
  CALENDAR: "calendar", // availability, rates, housekeeping board
  GUESTS: "guests", // guest profiles and stay history
  SETTINGS: "settings", // property, rooms, channels, extras, team
  // ── Legacy keys, kept so existing staff records stay valid ──────────────
  CONTACTS: "contacts", // folded into "guests"
  AUTOMATIONS: "automations", // AI assistant configuration
  BROADCASTS: "broadcasts", // guest messaging campaigns
  CONTENT: "content", // social posting (legacy)
  ANALYTICS: "analytics", // reporting
  INTEGRATIONS: "integrations", // apps and webhooks
};

/**
 * UI-facing catalogue (label + description) so the invite modal can render it.
 * Only the roles a hotel actually staffs are listed — legacy keys still work
 * but are no longer offered when inviting someone new.
 */
const PERMISSION_LIST = [
  {
    key: PERMISSIONS.BOOKINGS,
    label: "Bookings",
    desc: "See reservations, check guests in and out, add extras",
  },
  {
    key: PERMISSIONS.INBOX,
    label: "Guest messages",
    desc: "Reply to guests on WhatsApp, Instagram, Messenger & Telegram",
  },
  {
    key: PERMISSIONS.CALENDAR,
    label: "Calendar & rates",
    desc: "Availability, nightly rates and the housekeeping board",
  },
  {
    key: PERMISSIONS.GUESTS,
    label: "Guests",
    desc: "Guest profiles, stay history and preferences",
  },
  {
    key: PERMISSIONS.ANALYTICS,
    label: "Reports",
    desc: "Occupancy, revenue and channel performance",
  },
  {
    key: PERMISSIONS.SETTINGS,
    label: "Settings",
    desc: "Property details, rooms, channels and extras",
  },
];

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

/**
 * What a new staff member gets when the owner doesn't pick anything — the
 * front-desk essentials: see today's bookings and answer guests.
 */
const DEFAULT_AGENT_PERMISSIONS = [PERMISSIONS.BOOKINGS, PERMISSIONS.INBOX];

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
