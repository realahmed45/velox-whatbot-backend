/**
 * WhatsApp via AiSensy — end-to-end. Connect → guest message (AiSensy envelope
 * AND Meta Cloud shape) on our per-connection webhook → AI replies through
 * AiSensy with this hotel's credentials. Only AiSensy's HTTP calls are stubbed.
 * Run: node scripts/testWhatsAppAisensy.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log("  PASS  " + l); } else { fail++; console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const ais = require("../src/services/channels/aisensyService");
  const sent = [];
  ais.verifyCredentials = async (c) => (c.password === "wrong-pass" ? { ok: false, reason: "rejected" } : { ok: true });
  ais.sendDM = async (accountId, to, text) => { sent.push({ creds: ais.readCreds(accountId), to, text }); return { success: true, messageId: "m" + sent.length }; };

  const Workspace = require("../src/models/Workspace");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Contact = require("../src/models/Contact");
  const ctrl = require("../src/controllers/aisensyController");
  const real = require("../src/services/channels/aisensyService");

  console.log("\n0. Webhook parsing");
  const env = real.parseWebhook({ topic: "message.sender.user", data: { message: { phone_number: "+62 812 1111 2222", userName: "Sofia", message_type: "TEXT", message_content: { text: "Hi" }, id: "a1", sender: "USER" } } });
  ok(env.length === 1 && env[0].from === "6281211112222" && env[0].text === "Hi", "AiSensy envelope parsed", env[0]);
  const echo = real.parseWebhook({ topic: "message.sender.agent", data: { message: { phone_number: "628", message_content: { text: "x" }, sender: "AGENT" } } });
  ok(echo.length === 0, "agent/outbound events ignored");
  const meta = real.parseWebhook({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "628999", profile: { name: "Lukas" } }], messages: [{ from: "628999", id: "w1", type: "text", text: { body: "Yo" } }] } }] }] });
  ok(meta.length === 1 && meta[0].name === "Lukas", "Meta Cloud shape parsed too");

  const GUEST = "62812" + String(Date.now()).slice(-7);
  let ws;
  try {
    ws = await Workspace.create({ name: "AiSensy Test Hotel " + Date.now(), owner: new mongoose.Types.ObjectId(), industry: "hospitality", subscription: { plan: "hotel_pro", status: "active" } });

    console.log("\n1. Connect with AiSensy Project ID + API password");
    let bad = null;
    try { await ctrl._internal.connect(ws._id, { projectId: "P1", apiKey: "wrong-pass" }); } catch (e) { bad = e; }
    ok(bad && /rejected/i.test(bad.message), "wrong password refused clearly", bad?.message);
    const { webhookUrl } = await ctrl._internal.connect(ws._id, { projectId: "proj-" + Date.now(), apiKey: "good-pass-123" });
    ok(/\/api\/channels\/whatsapp\/aisensy\/hook\/[a-f0-9]{48}$/.test(webhookUrl), "webhook URL handed back", webhookUrl);
    const token = webhookUrl.split("/hook/")[1];
    const doc = await Workspace.findById(ws._id).select("+channels.accountId").lean();
    const entry = doc.channels.find((c) => c.platform === "whatsapp");
    ok(entry?.provider === "aisensy" && entry.status === "connected", "stored as WhatsApp via AiSensy");
    ok(entry?.accountId && !entry.accountId.includes("good-pass"), "credentials encrypted");
    ok(ctrl.webhookUrlFor(entry) === webhookUrl, "webhook URL can be shown again later");

    console.log("\n2. Guest messages via the AiSensy webhook");
    let status = null;
    await ctrl.webhook({ params: { token }, body: { topic: "message.sender.user", data: { message: { phone_number: GUEST, userName: "Sofia Rossi", message_type: "TEXT", message_content: { text: "Room for 2 this weekend?" }, id: "in1", sender: "USER" } } } }, { sendStatus: (s) => (status = s) });
    ok(status === 200, "acknowledged immediately");
    for (let i = 0; i < 40 && !sent.length; i++) await wait(500);
    const conv = await Conversation.findOne({ workspaceId: ws._id }).lean();
    ok(conv?.channelType === "whatsapp", "conversation filed under WhatsApp");
    const contact = await Contact.findOne({ workspaceId: ws._id }).lean();
    ok(contact?.name === "Sofia Rossi", "guest saved by name", contact?.name);

    console.log("\n3. The AI replies through AiSensy");
    ok(sent.length >= 1, "reply sent", sent.length);
    ok(sent[0]?.creds?.password === "good-pass-123", "sent with this hotel's own AiSensy credentials");
    ok(sent[0]?.to === GUEST, "sent to the guest");

    console.log("\n4. Forged webhooks are dropped");
    const n = sent.length;
    await ctrl.webhook({ params: { token: "nope" }, body: { topic: "message.sender.user", data: { message: { phone_number: GUEST, message_content: { text: "x" }, sender: "USER" } } } }, { sendStatus: () => {} });
    await wait(1200);
    ok(sent.length === n, "unknown token ignored");
  } catch (e) { fail++; console.log("  ERROR:", e.message, e.stack); }
  finally {
    if (ws) await Promise.all([Message.deleteMany({ workspaceId: ws._id }), Conversation.deleteMany({ workspaceId: ws._id }), Contact.deleteMany({ workspaceId: ws._id }), Workspace.deleteMany({ _id: ws._id })]).catch(() => {});
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
