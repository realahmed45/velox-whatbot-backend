/**
 * WuBook (WooDoo) end-to-end: import rooms + linked sites → reservation push →
 * availability push → guest message in the Airbnb inbox answered by the AI in
 * the same WuBook thread. WuBook's servers (XML-RPC + Wired JSON) are faked in
 * memory; everything else is the real code. Run: node scripts/testWubook.js
 */
require("dotenv").config();
process.env.WUBOOK_TOKEN = "test-token";
process.env.WUBOOK_API_KEY = "test-key";
process.env.WUBOOK_WEBHOOK_TOKEN = "hook-secret";
const mongoose = require("mongoose");
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log("  PASS  " + l); } else { fail++; console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : "")); } };

(async () => {
  // ── XML-RPC codec unit checks (real code) ────────────────────────────────
  const x = require("../src/utils/xmlrpc");
  console.log("\n0. XML-RPC codec");
  const xml = x.buildCall("update_avail", ["tok", 1234, "21/12/2026", [{ id: 7, days: [{ avail: 2 }] }]]);
  ok(xml.includes("<methodName>update_avail</methodName>") && xml.includes("<int>1234</int>") && xml.includes("<name>avail</name>"), "request serialised");
  const parsed = x.parseResponse(`<?xml version="1.0"?><methodResponse><params><param><value><array><data><value><int>0</int></value><value><array><data><value><struct><member><name>id</name><value><int>7</int></value></member><member><name>name</name><value><string>Deluxe &amp; Pool</string></value></member></struct></value></data></array></value></data></array></value></param></params></methodResponse>`);
  ok(parsed[0] === 0 && parsed[1][0].id === 7 && parsed[1][0].name === "Deluxe & Pool", "response parsed (codes, structs, entities)");
  let faulted = false;
  try { x.parseResponse(`<methodResponse><fault><value><struct><member><name>faultCode</name><value><int>4</int></value></member><member><name>faultString</name><value><string>nope</string></value></member></struct></value></fault></methodResponse>`); } catch { faulted = true; }
  ok(faulted, "XML-RPC fault raised as an error");

  // ── Fake WuBook ───────────────────────────────────────────────────────────
  const calls = [];
  const LCODE = 1234;
  const CH = [{ id: 46, tag: "Airbnb" }, { id: 2, tag: "Booking.com" }, { id: 3, tag: "Expedia" }, { id: 9, tag: "Trip.com" }];
  const ROOMS = [
    { id: 101, name: "Ocean Deluxe", occupancy: 2, men: 2, children: 0, availability: 3, price: 120, subroom: 0 },
    { id: 102, name: "Garden Villa", occupancy: 4, men: 3, children: 1, availability: 2, price: 220, subroom: 0 },
    { id: 103, name: "Ocean Deluxe (non-refundable)", occupancy: 2, availability: 3, price: 100, subroom: 101 },
  ];
  const day = (offset) => { const d = new Date(Date.now() + offset * 86400000); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };
  const BOOKING = { reservation_code: 987654, status: 1, id_channel: 46, channel_reservation_code: "HMABC123", date_arrival: day(5), date_departure: day(7), booked_rooms: [{ room_id: 101 }], customer_name: "Maya", customer_surname: "Chen", customer_mail: "maya@example.com", customer_phone: "+61400000000", men: 2, children: 0, amount: 240, currency: "USD" };
  x.xmlrpcCall = async (url, method, params) => {
    calls.push({ method, params });
    if (method === "fetch_rooms") return [0, ROOMS];
    if (method === "get_otas") return [0, CH];
    if (method === "push_activation") return [0, ""];
    if (method === "fetch_booking") return [0, [BOOKING]];
    if (method === "update_avail") return [0, ""];
    if (method === "update_plan_prices") return [0, ""];
    if (method === "fetch_new_bookings") return [0, []];
    return [1, "unexpected " + method];
  };
  const axios = require("axios");
  const realPost = axios.post.bind(axios);
  const jsonCalls = [];
  axios.post = async (url, body, cfg) => {
    if (!String(url).includes("wired-json")) return realPost(url, body, cfg);
    jsonCalls.push(body);
    const m = body.method;
    if (m === "messages_thread:search") return { data: { result: body.params.channel_id === 46 ? [{ id: 555, reservation_id: 987654, last_message_date: new Date().toISOString() }] : [] } };
    if (m === "messages_thread:retrieve") return { data: { result: [{ id: 555, reservation_id: 987654, guest_name: "Maya Chen", messages: [{ id: "g1", sender: "guest", message_text: "Hi! Can we check in early on Friday?", date: new Date().toISOString() }] }] } };
    if (m === "messages_thread:send") return { data: { result: { queued: true } } };
    return { data: { error: { message: "unknown " + m } } };
  };

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const wubook = require("../src/services/channels/wubookService");
  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Contact = require("../src/models/Contact");
  const Guest = require("../src/models/Guest");

  let ws, prop;
  try {
    ws = await Workspace.create({ name: "WuBook Test Villa " + Date.now(), owner: new mongoose.Types.ObjectId(), industry: "hospitality", subscription: { plan: "hotel_pro", status: "active" }, settings: { automationEnabled: true } });

    console.log("\n1. Import the WuBook property (rooms + linked sites)");
    const r = await wubook.importProperty(ws._id, LCODE, { name: "Villa Senja" });
    prop = r.property;
    ok(r.roomTypes.length === 2, "2 real rooms imported (virtual room skipped)", r.roomTypes.length);
    ok(r.roomTypes.every((t) => t.wubookRoomId), "rooms linked to WuBook ids");
    ok(prop.channel.provider === "wubook" && prop.channel.wubookLcode === String(LCODE), "property on WuBook");
    ok(["airbnb", "booking_com", "expedia", "trip_com"].every((o) => prop.channel.connectedOtas.includes(o)), "all 4 sites detected", prop.channel.connectedOtas);
    ok(calls.some((c) => c.method === "push_activation" && String(c.params[2]).includes("/api/wubook/push?token=hook-secret")), "reservation push registered");

    console.log("\n2. A reservation arrives from Airbnb (push)");
    const pr = await wubook.handlePush({ rcode: "987654", lcode: String(LCODE) });
    ok(pr.ok, "push handled", pr);
    const bk = await HotelBooking.findOne({ propertyId: prop._id }).populate("roomTypeId", "name").lean();
    ok(bk?.source === "airbnb", "booking source = Airbnb", bk?.source);
    ok(bk?.roomTypeId?.name === "Ocean Deluxe", "mapped to the right room", bk?.roomTypeId?.name);
    ok(bk?.nights === 2 && bk?.guestName === "Maya Chen", "dates + guest read", { nights: bk?.nights, guest: bk?.guestName });
    await wubook.handlePush({ rcode: "987654", lcode: String(LCODE) });
    ok((await HotelBooking.countDocuments({ propertyId: prop._id })) === 1, "re-push is idempotent");

    console.log("\n3. Availability push (DD/MM/YYYY, per night)");
    const room = await RoomType.findOne({ propertyId: prop._id, wubookRoomId: "101" });
    const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    await wubook.pushAvailabilityRange(prop, room, from, new Date(from.getTime() + 10 * 86400000));
    const av = calls.filter((c) => c.method === "update_avail").pop();
    ok(av && /^\d{2}\/\d{2}\/\d{4}$/.test(av.params[2]), "European date format", av?.params[2]);
    ok(av?.params[3]?.[0]?.id === 101 && av.params[3][0].days.length === 10, "10 nights for room 101");
    const nightsAvail = av.params[3][0].days.map((d) => d.avail);
    ok(nightsAvail[5] === 2 && nightsAvail[0] === 3, "booked nights reduce availability (3 → 2)", nightsAvail);

    console.log("\n4. Guest writes in the Airbnb inbox → AI answers in the same thread");
    const otaMessages = require("../src/services/hotel/otaMessageService");
    const res = await otaMessages.poll();
    ok(res.ok && res.handled >= 1, "guest message picked up and handled", res);
    const conv = await Conversation.findOne({ workspaceId: ws._id }).lean();
    ok(conv?.channelType === "airbnb", "conversation under Airbnb", conv?.channelType);
    ok(/Ocean Deluxe/.test(conv?.metadata?.otaContext || ""), "AI sees the guest's reservation", conv?.metadata?.otaContext);
    const send = jsonCalls.find((c) => c.method === "messages_thread:send");
    ok(send?.params?.thread_id === 555 && send.params.channel_id === 46 && send.params.property_id === LCODE, "reply posted to WuBook thread 555 on Airbnb", send?.params);
    ok(!/botlify\.app/i.test(send?.params?.message_text || ""), "no branding inside the OTA inbox");
    await otaMessages.poll();
    ok(jsonCalls.filter((c) => c.method === "messages_thread:send").length === 1, "not answered twice");

    console.log("\n5. Webhook routing");
    ok(wubook.classifyWebhook({ method: "messages_thread:notify", params: { type: "thread_updated", property_id: 1234, channel_id: 46, thread_id: 555 } }).composite === "1234|46|555", "thread webhook → thread sync");
    ok(wubook.classifyWebhook({ method: "communication:notify", params: { type: "reservation_new", property_id: 1234, reservation_code: 1 } }).kind === "reservation", "reservation webhook → booking fetch");
    ok(wubook.verifyWebhookToken("hook-secret") && !wubook.verifyWebhookToken("x"), "webhook token checked");
  } catch (e) { fail++; console.log("  ERROR:", e.message, e.stack); }
  finally {
    if (ws) {
      await Promise.all([
        Message.deleteMany({ workspaceId: ws._id }), Conversation.deleteMany({ workspaceId: ws._id }), Contact.deleteMany({ workspaceId: ws._id }),
        HotelBooking.deleteMany({ workspaceId: ws._id }), RoomType.deleteMany({ workspaceId: ws._id }), Property.deleteMany({ workspaceId: ws._id }),
        Guest.deleteMany({ workspaceId: ws._id }).catch(() => {}), Workspace.deleteMany({ _id: ws._id }),
      ]).catch(() => {});
    }
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
