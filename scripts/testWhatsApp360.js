/**
 * WhatsApp via 360dialog — end-to-end.
 *
 * Connect with an API key → guest message arrives in Meta Cloud API format on
 * our per-connection webhook → AI replies through 360dialog to the right number
 * with the right key. Only 360dialog's HTTP calls are stubbed.
 *
 * Needs MONGODB_URI in .env. Creates and deletes its own data.
 * Run: node scripts/testWhatsApp360.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0;
let fail = 0;
const ok = (c, l, x) => {
  if (c) {
    pass++;
    console.log("  PASS  " + l);
  } else {
    fail++;
    console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : ""));
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  const d360 = require("../src/services/channels/dialog360Service");
  const hooks = [];
  const sent = [];
  d360.configureWebhook = async (key, url) => {
    if (key === "BAD-KEY-123456") {
      const e = new Error("unauthorized");
      e.response = { status: 401 };
      throw e;
    }
    hooks.push({ key, url });
    return { url };
  };
  d360.sendDM = async (key, to, text) => {
    sent.push({ key, to, text });
    return { success: true, messageId: "wamid.out" + sent.length };
  };

  const Workspace = require("../src/models/Workspace");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Contact = require("../src/models/Contact");
  const ctrl = require("../src/controllers/dialog360Controller");

  // ── parser unit checks ──────────────────────────────────────────────────
  console.log("\n0. Meta Cloud API payload parsing");
  const parsed = d360.parseWebhook({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+62 811 000 111", phone_number_id: "PN1" },
              contacts: [{ wa_id: "6281234567890", profile: { name: "Sofia" } }],
              messages: [
                { from: "6281234567890", id: "wamid.A", timestamp: "1794700000", type: "text", text: { body: "Hi!" } },
              ],
              statuses: [{ id: "wamid.X", status: "read", recipient_id: "628" }],
            },
          },
        ],
      },
    ],
  });
  ok(parsed.messages.length === 1 && parsed.messages[0].text === "Hi!", "text message parsed");
  ok(parsed.messages[0].name === "Sofia", "sender name from contacts[]");
  ok(parsed.statuses.length === 1, "status updates kept separate (never treated as messages)");
  ok(d360.parseChannels("[abc,def]").join() === "abc,def", "connect redirect channels parsed");

  const KEY = "D360-TEST-" + Date.now();
  const GUEST = "62812" + String(Date.now()).slice(-7);
  let ws;
  try {
    ws = await Workspace.create({
      name: "360dialog Test Hotel " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
      subscription: { plan: "hotel_pro", status: "active" },
    });

    console.log("\n1. Connect WhatsApp with a 360dialog API key");
    let badErr = null;
    try {
      await ctrl._internal.connectWithKey(ws._id, "BAD-KEY-123456");
    } catch (e) {
      badErr = e;
    }
    ok(badErr && /rejected/i.test(badErr.message), "a bad key is refused with a clear message", badErr?.message);

    await ctrl._internal.connectWithKey(ws._id, KEY);
    ok(hooks.length === 1 && hooks[0].key === KEY, "number's webhook pointed at Botlify");
    const token = hooks[0].url.split("/hook/")[1];
    ok(token && token.length >= 32, "webhook URL carries a random per-connection token");
    const fresh = await Workspace.findById(ws._id).select("+channels.accountId").lean();
    const entry = fresh.channels.find((c) => c.platform === "whatsapp");
    ok(entry?.provider === "360dialog" && entry?.status === "connected", "stored as WhatsApp via 360dialog");
    ok(entry?.accountId && entry.accountId !== KEY, "API key stored encrypted");
    ok(fresh.settings?.automationEnabled === true, "automation switched on so guests get answers");

    console.log("\n2. A guest messages the hotel on WhatsApp");
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "+62 811 000 111", phone_number_id: "PN1" },
                contacts: [{ wa_id: GUEST, profile: { name: "Sofia Rossi" } }],
                messages: [
                  {
                    from: GUEST,
                    id: "wamid.in1",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Hi, do you have a room for 2 this weekend?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    let status = null;
    await ctrl.webhook(
      { params: { token }, body: payload },
      { sendStatus: (s) => (status = s) },
    );
    ok(status === 200, "webhook acknowledged immediately");
    for (let i = 0; i < 40 && !sent.length; i++) await wait(500);

    const conv = await Conversation.findOne({ workspaceId: ws._id }).lean();
    ok(conv?.channelType === "whatsapp", "conversation filed under WhatsApp");
    const contact = await Contact.findOne({ workspaceId: ws._id }).lean();
    ok(contact?.name === "Sofia Rossi", "guest saved by WhatsApp profile name", contact?.name);
    const inbound = await Message.findOne({ workspaceId: ws._id, direction: "inbound" }).lean();
    ok(inbound?.channelType === "whatsapp", "guest message stored as WhatsApp", inbound?.channelType);

    console.log("\n3. The AI replies through 360dialog");
    ok(sent.length >= 1, "reply sent via 360dialog", sent.length);
    ok(sent[0]?.key === KEY, "sent with this hotel's own API key");
    ok(sent[0]?.to === GUEST, "sent to the guest who wrote");
    const after = await Workspace.findById(ws._id).lean();
    const e2 = after.channels.find((c) => c.platform === "whatsapp");
    ok(!!e2?.lastWebhookAt, "heartbeat recorded");
    ok(e2?.phoneNumber === "+62 811 000 111", "hotel's WhatsApp number learned from the webhook");

    console.log("\n4. Unknown webhook tokens are dropped");
    const before = sent.length;
    await ctrl.webhook({ params: { token: "not-a-real-token" }, body: payload }, { sendStatus: () => {} });
    await wait(1500);
    ok(sent.length === before, "forged webhook ignored", sent.length - before);
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    if (ws) {
      await Promise.all([
        Message.deleteMany({ workspaceId: ws._id }),
        Conversation.deleteMany({ workspaceId: ws._id }),
        Contact.deleteMany({ workspaceId: ws._id }),
        Workspace.deleteMany({ _id: ws._id }),
      ]).catch(() => {});
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
