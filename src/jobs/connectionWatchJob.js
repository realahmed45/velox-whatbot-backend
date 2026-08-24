/**
 * connectionWatchJob — moves OTA connections forward without anyone watching.
 *
 * The founder's promise is that the hotelier connects once and never thinks
 * about the approval again. That only works if something checks on their
 * behalf: Booking.com's review takes 1–5 days and nobody is going to sit on a
 * status page for it. Every 15 minutes we sweep the properties that are still
 * moving (`importing` / `awaiting_ota_approval`), ask their provider what
 * changed, and the moment one genuinely goes live we email the owner.
 *
 * The email fires exactly once per property, on the transition INTO `live` —
 * the previous state is read before the refresh writes over it, so a restart
 * or a re-run can't re-send it.
 *
 * Best-effort throughout: this runs on a cron and must never throw. A provider
 * outage means we simply try again in fifteen minutes.
 */
const Property = require("../models/Property");
const Workspace = require("../models/Workspace");
const User = require("../models/User");
const logger = require("../utils/logger");
const {
  refreshConnectionState,
  STATES,
  TRANSITIONAL,
  prettyOta,
  humanJoin,
} = require("../services/hotel/connectionService");

const MAX_PER_RUN = 200;

const runConnectionWatch = async () => {
  let properties = [];
  try {
    properties = await Property.find({
      active: true,
      "channel.provider": { $in: ["channex", "beds24"] },
      "channel.sync.state": { $in: TRANSITIONAL },
    })
      .sort({ "channel.sync.lastCheckedAt": 1 })
      .limit(MAX_PER_RUN);
  } catch (err) {
    logger.warn(`[cron:connectionWatch] property lookup failed: ${err.message}`);
    return { scanned: 0, advanced: 0 };
  }

  let advanced = 0;
  for (const property of properties) {
    // Read the state BEFORE the refresh overwrites it — this is what makes the
    // "went live" email fire once and only once.
    const before = property.channel?.sync?.state;
    try {
      const sync = await refreshConnectionState(property);
      if (sync.state !== before) advanced++;
      if (sync.state === STATES.LIVE && before !== STATES.LIVE) {
        await notifyLive(property, sync);
      }
    } catch (err) {
      logger.warn(
        `[cron:connectionWatch] property=${property._id} failed: ${err.message}`,
      );
    }
  }

  if (properties.length) {
    logger.info(
      `[cron:connectionWatch] ${advanced}/${properties.length} connections advanced`,
    );
  }
  return { scanned: properties.length, advanced };
};

/**
 * Tell the owner their channel is syncing. This is the payoff moment of the
 * whole flow — the thing they were told would happen in the background,
 * happening. Never throws: a bounced email must not stall the sweep.
 */
async function notifyLive(property, sync) {
  try {
    const workspace = await Workspace.findById(property.workspaceId)
      .select("owner name")
      .lean();
    if (!workspace?.owner) return;
    const owner = await User.findById(workspace.owner).select("email name").lean();
    if (!owner?.email) return;

    const live = (sync.otaStatus || [])
      .filter((o) => o.status === "live")
      .map((o) => prettyOta(o.ota));
    const channels = humanJoin(live) || "your booking channel";
    const hotel = property.name || "Your property";

    const { sendEmail } = require("../services/emailService");
    const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || "";

    await sendEmail({
      to: owner.email,
      subject: `${channels} is now syncing with Botlify`,
      html: `
        <p>Hi ${owner.name || "there"},</p>
        <p><strong>${channels} is now syncing with Botlify.</strong></p>
        <p>The connection for <strong>${hotel}</strong> has been approved and is live.
        From now on your rates and availability travel in both directions
        automatically — a booking on any channel updates the others, and
        anything your AI sells closes the rooms everywhere.</p>
        <p>There is nothing for you to do. This is just so you know it happened.</p>
        ${appUrl ? `<p><a href="${appUrl}/dashboard">Open your dashboard</a></p>` : ""}
        <p>— The Botlify team</p>
      `,
      text:
        `${channels} is now syncing with Botlify. The connection for ${hotel} has been ` +
        `approved and is live — rates and availability now sync both ways automatically.`,
    });

    logger.info(
      `[cron:connectionWatch] live email sent property=${property._id} to=${owner.email}`,
    );
  } catch (err) {
    logger.warn(`[cron:connectionWatch] live email failed: ${err.message}`);
  }
}

module.exports = { runConnectionWatch };
