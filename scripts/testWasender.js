/**
 * WhatsApp via WasenderAPI — end-to-end. QR start → session connected →
 * guest message on our webhook (signature checked) → AI replies through
 * WasenderAPI. Only WasenderAPI's HTTP calls are stubbed.
 * Run: node scripts/testWasender.js
 */
require("dotenv").config();
process.env.WASENDER_PAT = process.env.WASENDER_PAT || "test-pat";
const mongoose = require("mongoose");
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log("  PASS  " + l); } else { fail++; console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const resMock = () => { const r = { code: 200, headersSent: false }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; r.headersSent = true; return r; }; r.sendStatus = (c) => { r.code = c; r.headersSent = true; return r; }; return r; };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const w = require("../src/services/channels/wasenderService");
  const real = { parseWebhook: w.parseWebhook, parseSessionStatus: w.parseSessionStatus };
  const sent = []; let state = "need_scan"; let createdHook = null;
  w.createSession = async ({ webhookUrl }) => { createdHook = webhookUrl; return { sessionId: "77", apiKey: "k".repeat(64), webhookSecret: "secret-abc-123", status: "need_scan" }; };
  w.connectSession = async () => ({});
  w.getSession = async () => ({ status: state, phoneNumber: "+62811000111" });
  w.getQr = async () => "data:image/png;base64,QR";
  w.sendDM = async (accountId, to, text) => { sent.push({ creds: w.readCreds(accountId), to, text }); return { success: true, messageId: "1" }; };

  console.log("\n0. Webhook parsing");
  const p = real.parseWebhook({ event: "messages.received", data: { messages: { key: { id: "M1", fromMe: false, remoteJid: "555@lid", cleanedSenderPn: "6281234" }, pushName: "Sofia", messageBody: "Hi!" } } });
  ok(p.length === 1 && p[0].from === "6281234" && p[0].text === "Hi!", "guest message parsed (LID-safe phone)", p[0]);
  ok(real.parseWebhook({ event: "messages.received", data: { messages: { key: { fromMe: true, cleanedSenderPn: "1" }, messageBody: "x" } } }).length === 0, "our own messages ignored");
  ok(real.parseWebhook({ event: "messages.received", data: { messages: { key: { remoteJid: "123@g.us", cleanedSenderPn: "1" }, messageBody: "x" } } }).length === 0, "group messages ignored");
  ok(real.parseSessionStatus({ event: "session.status", data: { status: "connected" } }) === "connected", "session status event parsed");

  const Workspace = require("../src/models/Workspace");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Contact = require("../src/models/Contact");
  const ctrl = require("../src/controllers/wasenderController");
  const GUEST = "62812" + String(Date.now()).slice(-7);
  let ws;
  try {
    ws = await Workspace.create({ name: "Wasender Test Villa " + Date.now(), owner: new mongoose.Types.ObjectId(), industry: "hospitality", subscription: { plan: "hotel_pro", status: "active" } });
    const req = (body = {}) => ({ body, workspace: ws });

    console.log("\n1. Hotel types its number → QR code");
    let r = resMock();
    await ctrl.start(req({ phoneNumber: "+62 811 000 111" }), r, (e) => { throw e; });
    ok(r.body?.success && r.body?.qr?.startsWith("data:image"), "QR returned to the dashboard", r.body);
    ok(/\/wasender\/hook\/[a-f0-9]{48}$/.test(createdHook || ""), "session created with webhook pre-pointed at Botlify");
    let doc = await Workspace.findById(ws._id).select("+channels.accountId").lean();
    let e = doc.channels.find((c) => c.platform === "whatsapp");
    ok(e?.provider === "wasender" && e.status === "pending", "pending until scanned", e?.status);
    ok(!String(e.accountId).includes("secret-abc"), "credentials encrypted");

    console.log("\n2. Hotel scans → connected");
    state = "connected";
    r = resMock();
    await ctrl.qr(req(), r, (err) => { throw err; });
    ok(r.body?.status === "connected", "status poll reports connected");
    doc = await Workspace.findById(ws._id).lean();
    ok(doc.channels.find((c) => c.platform === "whatsapp").status === "connected", "channel marked connected");

    console.log("\n3. Guest messages → AI replies through WasenderAPI");
    const token = createdHook.split("/hook/")[1];
    const payload = { event: "messages.received", timestamp: Date.now(), data: { messages: { key: { id: "IN1", fromMe: false, remoteJid: GUEST + "@s.whatsapp.net", cleanedSenderPn: GUEST }, pushName: "Sofia Rossi", messageBody: "Hi, room for 2 this weekend?" } } };
    let bad = resMock();
    await ctrl.webhook({ params: { token }, headers: { "x-webhook-signature": "wrong" }, body: payload }, bad);
    ok(bad.code === 401, "wrong signature rejected (401)");
    await wait(500);
    ok(sent.length === 0, "nothing answered for the forged call");
    r = resMock();
    await ctrl.webhook({ params: { token }, headers: { "x-webhook-signature": "secret-abc-123" }, body: payload }, r);
    ok(r.code === 200, "valid webhook acknowledged");
    for (let i = 0; i < 40 && !sent.length; i++) await wait(500);
    const conv = await Conversation.findOne({ workspaceId: ws._id }).lean();
    ok(conv?.channelType === "whatsapp", "conversation under WhatsApp");
    const contact = await Contact.findOne({ workspaceId: ws._id }).lean();
    ok(contact?.name === "Sofia Rossi", "guest saved by WhatsApp name", contact?.name);
    ok(sent.length >= 1 && sent[0].to === GUEST, "AI reply sent to the guest", sent[0]);
    ok(sent[0]?.creds?.apiKey === "k".repeat(64), "sent with this hotel's session key");

    console.log("\n4. Disconnect");
    r = resMock();
    w.deleteSession = async () => true;
    await ctrl.disconnect(req(), r, (err) => { throw err; });
    doc = await Workspace.findById(ws._id).lean();
    ok(doc.channels.find((c) => c.platform === "whatsapp").status === "disconnected", "disconnected and credentials cleared");
  } catch (err) { fail++; console.log("  ERROR:", err.message, err.stack); }
  finally {
    if (ws) await Promise.all([Message.deleteMany({ workspaceId: ws._id }), Conversation.deleteMany({ workspaceId: ws._id }), Contact.deleteMany({ workspaceId: ws._id }), Workspace.deleteMany({ _id: ws._id })]).catch(() => {});
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
