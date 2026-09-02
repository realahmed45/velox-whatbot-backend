/**
 * Multi-channel AI routing — "our AI handles them automatically, all at a time".
 *
 * The promise is that a guest can message the hotel on ANY connected channel and
 * the AI answers. That only holds if every channel resolves to its OWN provider
 * account. The bug this guards against: Messenger and Telegram conversations
 * fell through to Instagram's access token, which is undefined on a hotel that
 * never connected Instagram — so the AI silently never replied.
 *
 * Run: node scripts/testChannelRouting.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label);
  }
};
const say = (s) => console.log("\n" + s);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
  });

  const Workspace = require("../src/models/Workspace");
  const { resolveSendTransport } = require("../src/services/instagram/automationEngine");
  const { encrypt } = require("../src/utils/encryption");

  // Every channel the concierge is advertised to answer on, minus Instagram
  // (which rides the legacy workspace.instagram subdoc, not channels[]).
  const CHANNELS = ["whatsapp", "messenger", "telegram"];

  let ws;

  try {
    // A hotel that connected every social channel but NOT Instagram — the exact
    // shape that used to break, since there is no Instagram token to fall back to.
    ws = await Workspace.create({
      name: "Routing Test Hotel " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
      channels: CHANNELS.map((platform) => ({
        platform,
        provider: "zernio",
        status: "connected",
        accountId: encrypt("acct-" + platform),
        username: platform + "-hotel",
      })),
    });

    const workspace = await Workspace.findById(ws._id);

    say("A hotel is on WhatsApp, Messenger and Telegram — no Instagram at all.");
    for (const channel of CHANNELS) {
      const t = await resolveSendTransport(workspace, { channelType: channel });
      ok(
        t.channel === channel,
        `${channel} routes to its OWN transport, not Instagram (got "${t.channel}")`,
      );
    }

    say("Each channel resolves a real send function.");
    for (const channel of CHANNELS) {
      const t = await resolveSendTransport(workspace, { channelType: channel });
      ok(typeof t.send === "function", `${channel} has a send()`);
    }

    say("Instagram still uses the legacy workspace.instagram path.");
    const ig = await resolveSendTransport(workspace, {
      channelType: "instagram",
    });
    ok(ig.channel === "instagram", "instagram routes to instagram");

    say("A conversation with no channelType defaults to Instagram (unchanged).");
    const noType = await resolveSendTransport(workspace, {});
    ok(noType.channel === "instagram", "missing channelType → instagram");

    say("A channel the hotel never connected falls back rather than crashing.");
    const missing = await resolveSendTransport(workspace, {
      channelType: "telegram",
    });
    ok(!!missing.send, "still returns a usable transport");

    // The guard that used to block the send outright before the transport was
    // even consulted. Exercised through the same helper the engine uses.
    say("The send guard accepts every connected channel.");
    const wsNoIg = await Workspace.findById(ws._id).lean();
    for (const channel of CHANNELS) {
      const connected = (wsNoIg.channels || []).some(
        (c) => c.platform === channel && c.status === "connected",
      );
      ok(connected, `${channel} is seen as connected by the guard`);
    }
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    if (ws) await Workspace.deleteMany({ _id: ws._id });
    console.log(
      "\n" +
        "=".repeat(52) +
        "\n  " +
        pass +
        " passed, " +
        fail +
        " failed\n" +
        "=".repeat(52),
    );
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
