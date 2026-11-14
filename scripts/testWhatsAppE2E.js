/**
 * WhatsApp end-to-end — a guest messages the hotel, the AI answers.
 *
 * Drives the REAL pipeline: the Zernio webhook controller receives a
 * message.received event exactly as Zernio posts it, routes it to the hotel by
 * account hash, runs the AI, and calls the WhatsApp provider's sendDM. Only the
 * final network hop to Zernio is intercepted (no real message is sent), so the
 * test proves everything up to the wire.
 *
 * Needs MONGODB_URI and the AI key in .env. Creates and deletes its own data.
 * Run: node scripts/testWhatsAppE2E.js
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
    console.log("  FAIL  " + label + (extra ? `  (${extra})` : ""));
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  // Intercept the final hop BEFORE the pipeline loads it.
  const zernio = require("../src/services/channels/zernioSocialService");
  const sent = [];
  zernio.sendDM = async (accountId, recipientId, text, opts = {}) => {
    sent.push({ accountId, recipientId, text, opts });
    return { success: true, messageId: "test-" + sent.length };
  };

  const Workspace = require("../src/models/Workspace");
  const Contact = require("../src/models/Contact");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const { encrypt } = require("../src/utils/encryption");
  const { hashToken } = require("../src/utils/crypto");
  const ctrl = require("../src/controllers/instagramController");

  const ACCOUNT = "wa-e2e-" + Date.now();
  const GUEST = "62812" + String(Date.now()).slice(-7);
  let ws;

  try {
    ws = await Workspace.create({
      name: "WhatsApp E2E Hotel " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
      // A paying hotel, as in production — the AI only answers on a hotel plan.
      subscription: { plan: "hotel_pro", status: "active" },
      channels: [
        {
          platform: "whatsapp",
          provider: "zernio",
          status: "connected",
          accountId: encrypt(ACCOUNT),
          accountHash: hashToken(ACCOUNT),
          phoneNumber: "+62 811 0000 000",
        },
      ],
    });

    console.log("\n1. Guest sends a WhatsApp message (Zernio webhook shape)");
    const event = {
      event: "message.received",
      accountId: ACCOUNT,
      message: {
        id: "wamid." + Date.now(),
        platform: "whatsapp",
        direction: "incoming",
        text: "Hi! Do you have a room for 2 people next weekend? How much per night?",
        conversationId: "conv-" + GUEST,
        sender: { id: GUEST, name: "Test Guest" },
      },
    };
    const req = {
      body: Buffer.from(JSON.stringify(event)),
      headers: {},
    };
    let status = null;
    const res = { sendStatus: (s) => { status = s; return res; }, status: () => res, json: () => res };
    await ctrl.receiveBotlifyWebhook(req, res, (e) => { if (e) throw e; });
    ok(status === 200, "webhook acknowledged with 200", `got ${status}`);

    // The AI runs after the ack; give it time to think and send.
    for (let i = 0; i < 60 && !sent.length; i++) await wait(1000);

    console.log("\n2. Routing and storage");
    const fresh = await Workspace.findById(ws._id).lean();
    const wa = fresh.channels.find((c) => c.platform === "whatsapp");
    ok(!!wa?.lastWebhookAt, "message routed to the right hotel (lastWebhookAt stamped)");
    const contact = await Contact.findOne({ workspaceId: ws._id }).lean();
    ok(!!contact, "guest saved as a contact");
    const convo = await Conversation.findOne({ workspaceId: ws._id }).lean();
    ok(!!convo, "conversation created");
    ok(
      convo && (convo.channelType === "whatsapp" || convo.channel === "whatsapp"),
      "conversation is marked as WhatsApp",
      convo && (convo.channelType || convo.channel),
    );

    console.log("\n3. The AI replies on WhatsApp");
    ok(sent.length > 0, "a reply was sent through the WhatsApp provider");
    if (sent.length) {
      const r = sent[0];
      ok(r.accountId === ACCOUNT, "sent from the hotel's own WhatsApp account", r.accountId);
      ok(String(r.recipientId) === GUEST, "sent to the guest who wrote", r.recipientId);
      ok(String(r.text || "").trim().length > 10, "reply has real text");
      ok(
        !/thanks for following/i.test(r.text),
        "first message is NOT the old Instagram 'thanks for following' greeting",
      );
      if (process.env.GEMINI_API_KEY) {
        ok(
          !/teammate will get back/i.test(r.text),
          "AI actually answered (not the human-handoff fallback)",
        );
      } else {
        console.log(
          "  SKIP  AI answer quality — GEMINI_API_KEY not set locally (production has it: /api/ai/health)",
        );
      }
      console.log("\n  AI reply: " + String(r.text).slice(0, 300).replace(/\n/g, " ") + "\n");
    }
    const stored = await Message.countDocuments({ workspaceId: ws._id });
    ok(stored >= 1, "messages stored for the inbox", `count ${stored}`);
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    if (ws) {
      await Promise.all([
        Message.deleteMany({ workspaceId: ws._id }).catch(() => {}),
        Conversation.deleteMany({ workspaceId: ws._id }).catch(() => {}),
        Contact.deleteMany({ workspaceId: ws._id }).catch(() => {}),
        Workspace.deleteMany({ _id: ws._id }),
      ]);
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
