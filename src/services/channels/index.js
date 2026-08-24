/**
 * channels/index.js — provider router.
 *
 * A property syncs through exactly one channel manager, named in
 * `channel.provider`. Everything downstream (availability pushes after a
 * booking, rate pushes from the revenue engine) asks here rather than naming a
 * provider, so adding a third one is a line in this table, not a hunt through
 * call sites.
 *
 * Deliberately forgiving: an unknown provider, "none", "ical" (which has no
 * push API at all — it's import-only), or a provider whose keys aren't set all
 * return null. Callers treat null as "nothing to sync", which is the correct
 * behaviour for a hotel that hasn't connected an OTA yet.
 */
const PROVIDERS = {
  channex: "./channexService",
  beds24: "./beds24Service",
};

/**
 * The channel service for a property, or null when it has none / isn't
 * configured. Never throws — a missing integration must not break a booking.
 * @param {object} property  Property doc (or lean object) with `channel`
 * @returns {object|null}
 */
function getProvider(property) {
  const name = property?.channel?.provider;
  const path = PROVIDERS[name];
  if (!path) return null;
  try {
    const svc = require(path);
    return svc.isConfigured && svc.isConfigured() ? svc : null;
  } catch {
    return null;
  }
}

/** Does this property have a live, configured channel connection? */
const hasProvider = (property) => !!getProvider(property);

/**
 * The provider-specific room id for a property's room type, or null when the
 * room was never mapped (e.g. added by hand after the import).
 */
function providerRoomId(property, roomType) {
  switch (property?.channel?.provider) {
    case "channex":
      return roomType?.channexRoomTypeId || null;
    case "beds24":
      return roomType?.beds24RoomId || null;
    default:
      return null;
  }
}

module.exports = {
  getProvider,
  hasProvider,
  providerRoomId,
  PROVIDER_NAMES: Object.keys(PROVIDERS),
};
