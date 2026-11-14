/**
 * OTA guest messaging end-to-end — the core promise:
 * a guest writes in their Airbnb / Booking.com inbox, Botlify's AI answers in
 * that same thread, and the conversation lands in the hotel's inbox under the
 * right platform.
 *
 * Drives the REAL pipeline (otaMessageService.poll → ingest → automationEngine
 * → AI → resolveSendTransport → driver.send). Only the channel manager's HTTP
 * layer is replaced by an in-memory fake, so nothing leaves the machine.
 *
 * Needs MONGODB_URI in .env. Creates and deletes its own data.
 * Run: node scripts/testOtaMessaging.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label + (extra !== undefined ? `  (${JSON.stringify(extra)})` : ""));
  }
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  // ── Fake Channex messaging (the only stubbed layer) ─────────────────────
  const channex = require("../src/services/channels/channexService");
  const inbox = []; // what the channel manager would return on poll
  const sent = []; // what we posted back into OTA threads
  channex.messaging.isAvailable = () => true;
  channex.messaging.pollNew = async () => inbox.slice();
  channex.messaging.fetchThread = async (id) => inbox.filter((m) => m.threadId === id);
  channex.messaging.send = async ({ threadId, text }) => {
    sent.push({ threadId, text });
    return { success: true, messageId: "out-" + sent.length };
  };

  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Contact = require("../src/models/Contact");
  const ota = require("../src/services/hotel/otaMessageService");

  const PROP = "chx-prop-" + Date.now();
  const THREAD = "thr-" + Date.now();
  let ws;
  let property;
  const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

  try {
    ws = await Workspace.create({
      name: "OTA Messaging Test Villa " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
      subscription: { plan: "hotel_pro", status: "active" },
      settings: { automationEnabled: true },
    });
    property = await Property.create({
      workspaceId: ws._id,
      name: "Test Villa",
      channel: { provider: "channex", status: "connected", channexPropertyId: PROP },
    });

    console.log("\n1. An Airbnb guest writes in their inbox");
    inbox.push({
      provider: "channex",
      ota: "airbnb",
      threadId: THREAD,
      bookingRef: null,
      providerPropertyId: PROP,
      guestName: "Maya Chen",
      messageId: "m1",
      text: "Hi! What time is check-in? We land at 11am.",
      attachments: [],
      sender: "guest",
      at: at(1),
    });
    const r1 = await ota.poll();
    ok(r1.ok && r1.scanned === 1, "poll picked up the guest message", r1);

    const conv = await Conversation.findOne({ workspaceId: ws._id }).lean();
    ok(!!conv, "conversation created");
    ok(conv?.channelType === "airbnb", "filed under Airbnb in the inbox", conv?.channelType);
    ok(conv?.metadata?.ota?.threadId === THREAD, "remembers the Airbnb thread to reply into");
    const contact = await Contact.findOne({ workspaceId: ws._id }).lean();
    ok(contact?.name === "Maya Chen", "guest saved by name", contact?.name);
    ok(contact?.source === "airbnb", "guest source is Airbnb", contact?.source);

    const inbound = await Message.findOne({ workspaceId: ws._id, direction: "inbound" }).lean();
    ok(inbound?.channelType === "airbnb", "guest message stored as Airbnb (not instagram)", inbound?.channelType);

    console.log("\n2. The AI answers inside the same Airbnb thread");
    ok(sent.length === 1, "one reply posted back to the OTA", sent.length);
    ok(sent[0]?.threadId === THREAD, "reply went into the guest's own thread");
    ok(String(sent[0]?.text || "").length > 5, "reply has text");
    ok(!/botlify\.app|sent via/i.test(sent[0]?.text || ""), "no Botlify branding/link inside the OTA inbox");
    const outbound = await Message.findOne({ workspaceId: ws._id, direction: "outbound" }).lean();
    ok(outbound?.channelType === "airbnb", "AI reply stored under Airbnb", outbound?.channelType);
    console.log("\n  AI reply: " + String(sent[0]?.text || "").slice(0, 200).replace(/\n/g, " ") + "\n");

    console.log("\n3. Re-polling is safe");
    await ota.poll();
    ok(sent.length === 1, "same message not answered twice", sent.length);
    const inboundCount = await Message.countDocuments({ workspaceId: ws._id, direction: "inbound" });
    ok(inboundCount === 1, "guest message stored once", inboundCount);

    console.log("\n4. Our own reply echoing back from the OTA is recognised");
    inbox.push({
      provider: "channex",
      ota: "airbnb",
      threadId: THREAD,
      providerPropertyId: PROP,
      guestName: "Maya Chen",
      messageId: "m2-echo",
      text: outbound?.text,
      attachments: [],
      sender: "hotel",
      at: at(0),
    });
    await ota.poll();
    const outCount = await Message.countDocuments({ workspaceId: ws._id, direction: "outbound" });
    ok(outCount === 1, "echo not duplicated in the inbox", outCount);
    ok(sent.length === 1, "echo not answered", sent.length);

    console.log("\n5. A staff reply typed in the extranet is kept as history, never answered");
    inbox.push({
      provider: "channex",
      ota: "airbnb",
      threadId: THREAD,
      providerPropertyId: PROP,
      guestName: "Maya Chen",
      messageId: "m3-staff",
      text: "Hi Maya, Wayan from the front desk here — welcome!",
      attachments: [],
      sender: "hotel",
      at: at(0),
    });
    await ota.poll();
    const staffMsg = await Message.findOne({ workspaceId: ws._id, "metadata.externalId": "channex:m3-staff" }).lean();
    ok(!!staffMsg, "extranet reply stored in the conversation");
    ok(sent.length === 1, "AI didn't answer the staff message", sent.length);

    console.log("\n6. A Booking.com guest lands in its own Booking.com conversation");
    inbox.push({
      provider: "channex",
      ota: "booking_com",
      threadId: THREAD + "-b",
      providerPropertyId: PROP,
      guestName: "Lukas Weber",
      messageId: "m4",
      text: "Is breakfast included?",
      attachments: [],
      sender: "guest",
      at: at(0),
    });
    await ota.poll();
    const bconv = await Conversation.findOne({ workspaceId: ws._id, channelType: "booking_com" }).lean();
    ok(!!bconv, "Booking.com conversation created");
    ok(sent.some((s) => s.threadId === THREAD + "-b"), "AI replied in the Booking.com thread");

    console.log("\n7. The hotel can switch booking-site AI off — messages still arrive");
    await Workspace.updateOne({ _id: ws._id }, { $set: { "aiSettings.otaAiEnabled": false } });
    const before = sent.length;
    inbox.push({
      provider: "channex",
      ota: "airbnb",
      threadId: THREAD,
      providerPropertyId: PROP,
      guestName: "Maya Chen",
      messageId: "m5",
      text: "Can we have a late checkout?",
      attachments: [],
      sender: "guest",
      at: at(0),
    });
    await ota.poll();
    ok(sent.length === before, "AI stayed quiet with the switch off", sent.length - before);
    ok(
      await Message.exists({ workspaceId: ws._id, "metadata.externalId": "channex:m5" }),
      "guest message still stored for staff",
    );
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    if (ws) {
      await Promise.all([
        Message.deleteMany({ workspaceId: ws._id }),
        Conversation.deleteMany({ workspaceId: ws._id }),
        Contact.deleteMany({ workspaceId: ws._id }),
        Property.deleteMany({ workspaceId: ws._id }),
        Workspace.deleteMany({ _id: ws._id }),
      ]).catch(() => {});
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
