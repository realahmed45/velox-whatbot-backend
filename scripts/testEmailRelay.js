/**
 * Expedia / Trip.com guest messaging via email relay — end-to-end.
 * Brevo inbound payload → hotel resolved by its address → Expedia conversation
 * linked to the booking → AI reply emailed back to the guest's relay address.
 * Only Brevo's send API is stubbed. Run: node scripts/testEmailRelay.js
 */
require("dotenv").config();
process.env.INBOUND_EMAIL_DOMAIN = "in.botlify.test";
process.env.INBOUND_EMAIL_TOKEN = "relay-secret";
process.env.BREVO_API_KEY = process.env.BREVO_API_KEY || "test-brevo";
const mongoose = require("mongoose");
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log("  PASS  " + l); } else { fail++; console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const axios = require("axios");
  const realPost = axios.post.bind(axios);
  const emails = [];
  axios.post = async (url, body, cfg) => {
    if (String(url).includes("api.brevo.com/v3/smtp/email")) { emails.push(body); return { data: { messageId: "<m" + emails.length + ">" } }; }
    return realPost(url, body, cfg);
  };

  const relay = require("../src/services/channels/emailRelayService");
  console.log("\n0. Parsing + cleanup");
  ok(relay.otaFromSender("a1b2c3@m.expediapartnercentral.com") === "expedia", "Expedia relay recognised");
  ok(relay.otaFromSender("guest-889@relay.trip.com") === "trip_com", "Trip.com relay recognised");
  ok(relay.otaFromSender("friend@gmail.com") === null, "ordinary email ignored");
  const cleaned = relay.cleanBody("Can we check in at 1pm?\n\nOn Tue, 17 Nov 2026 at 10:00 Villa wrote:\n> old text");
  ok(cleaned === "Can we check in at 1pm?", "quoted history stripped", cleaned);

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Contact = require("../src/models/Contact");
  const Notification = require("../src/models/Notification");
  const ctrl = require("../src/controllers/hotelController");
  const { ingestOtaBooking } = require("../src/services/hotel/bookingService");

  const RELAY = `x${Date.now()}@m.expediapartnercentral.com`;
  let ws;
  try {
    ws = await Workspace.create({ name: "Relay Test Villa " + Date.now(), owner: new mongoose.Types.ObjectId(), industry: "hospitality", subscription: { plan: "hotel_pro", status: "active" }, settings: { automationEnabled: true } });
    const prop = await Property.create({ workspaceId: ws._id, name: "Villa Senja", currency: "USD" });
    const room = await RoomType.create({ workspaceId: ws._id, propertyId: prop._id, name: "Room 1", unitsCount: 2, baseRate: 100 });
    await ingestOtaBooking({ property: prop, roomType: room, otaReservationId: "EXP-9", source: "expedia", status: "confirmed", checkIn: new Date(Date.now() + 4 * 864e5), checkOut: new Date(Date.now() + 6 * 864e5), guestName: "Lukas Weber", guestEmail: RELAY.toUpperCase(), adults: 2, children: 0, totalAmount: 210, currency: "USD" });

    console.log("\n1. The hotel's own inbound address");
    let r = { json: (b) => (r.body = b), status: () => r };
    await ctrl.getEmailRelay({ workspace: ws, query: {}, body: {} }, r, (e) => { throw e; });
    const address = r.body?.address;
    ok(/^villa-senja-[a-f0-9]{6}@in\.botlify\.test$/.test(address || ""), "address created", address);

    console.log("\n2. An Expedia guest writes (Brevo inbound payload)");
    const payload = { items: [{ From: { Name: "Lukas Weber via Expedia", Address: RELAY }, To: [{ Address: address }], Recipients: [address], Subject: "Question about your reservation", RawTextBody: "Hi, can we check in early on arrival day?\n\n> quoted", ExtractedMarkdownMessage: "Hi, can we check in early on arrival day?", MessageId: "<in-" + Date.now() + "@expedia>" }] };
    let code = 0;
    await ctrl.handleInboundEmail({ query: { token: "nope" }, body: payload }, { sendStatus: (c) => (code = c) }, () => {});
    ok(code === 401, "wrong webhook token rejected");
    await ctrl.handleInboundEmail({ query: { token: "relay-secret" }, body: payload }, { sendStatus: (c) => (code = c) }, () => {});
    ok(code === 200, "inbound acknowledged");
    for (let i = 0; i < 40 && !emails.length; i++) await wait(500);

    const conv = await Conversation.findOne({ workspaceId: ws._id }).lean();
    ok(conv?.channelType === "expedia", "filed under Expedia in Messages", conv?.channelType);
    ok(/Lukas Weber/.test(conv?.metadata?.otaContext || "") && /EXP-9|BK/.test(conv?.metadata?.otaContext || ""), "linked to the guest's Expedia booking", conv?.metadata?.otaContext);
    const contact = await Contact.findOne({ workspaceId: ws._id }).lean();
    ok(contact?.name === "Lukas Weber", "guest name cleaned (no 'via Expedia')", contact?.name);

    console.log("\n3. The AI replies by email through the relay");
    ok(emails.length === 1, "one reply email sent", emails.length);
    ok(emails[0]?.to?.[0]?.email === RELAY, "sent to the guest's Expedia relay address");
    ok(emails[0]?.sender?.email === address && emails[0]?.replyTo?.email === address, "from + reply-to the hotel's address (next reply comes back to us)");
    ok(emails[0]?.subject === "Re: Question about your reservation", "threaded subject", emails[0]?.subject);
    ok(!/botlify\.app/i.test(emails[0]?.textContent || ""), "no branding in the guest message");
    await wait(400);
    ok(await Notification.exists({ workspaceId: ws._id, type: "message.new", channel: "expedia" }), "bell notification raised");

    console.log("\n4. Same email again → not answered twice; Trip.com works too");
    await ctrl.handleInboundEmail({ query: { token: "relay-secret" }, body: payload }, { sendStatus: () => {} }, () => {});
    await wait(1500);
    ok(emails.length === 1, "duplicate ignored");
    await ctrl.handleInboundEmail({ query: { token: "relay-secret" }, body: { items: [{ From: { Name: "Chen Wei", Address: "guest-77@relay.trip.com" }, To: [{ Address: address }], Subject: "Airport transfer", ExtractedMarkdownMessage: "Do you offer airport pickup?", MessageId: "<trip-1>" }] } }, { sendStatus: () => {} }, () => {});
    for (let i = 0; i < 40 && emails.length < 2; i++) await wait(500);
    ok(await Conversation.exists({ workspaceId: ws._id, channelType: "trip_com" }), "Trip.com conversation created");
    ok(emails[1]?.to?.[0]?.email === "guest-77@relay.trip.com", "AI replied to the Trip.com relay");
    await ctrl.handleInboundEmail({ query: { token: "relay-secret" }, body: { items: [{ From: { Address: "newsletter@shop.com" }, To: [{ Address: address }], Subject: "Sale", ExtractedMarkdownMessage: "50% off", MessageId: "<spam>" }] } }, { sendStatus: () => {} }, () => {});
    await wait(800);
    ok(emails.length === 2, "non-OTA email never answered");
  } catch (e) { fail++; console.log("  ERROR:", e.message, e.stack); }
  finally {
    if (ws) await Promise.all([Message.deleteMany({ workspaceId: ws._id }), Conversation.deleteMany({ workspaceId: ws._id }), Contact.deleteMany({ workspaceId: ws._id }), Notification.deleteMany({ workspaceId: ws._id }), HotelBooking.deleteMany({ workspaceId: ws._id }), RoomType.deleteMany({ workspaceId: ws._id }), Property.deleteMany({ workspaceId: ws._id }), Workspace.deleteMany({ _id: ws._id })]).catch(() => {});
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
