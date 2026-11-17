/**
 * Zero-touch site onboarding: the hotelier enters ONLY their Booking.com hotel
 * ID; Botlify claims a WuBook property, starts the connection, waits for the
 * hotel's approval, then reads Booking.com's rooms, creates + maps WuBook rooms
 * and rates, imports them and goes live. WuBook is faked in memory.
 * Run: node scripts/testWubookOnboarding.js
 */
require("dotenv").config();
process.env.WUBOOK_TOKEN = "test-token";
process.env.WUBOOK_WEBHOOK_TOKEN = "hook";
process.env.WUBOOK_SPARE_LCODES = "5001,5002";
const mongoose = require("mongoose");
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log("  PASS  " + l); } else { fail++; console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : "")); } };
const resMock = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

(async () => {
  const x = require("../src/utils/xmlrpc");
  const calls = [];
  let approved = false;
  const wbRooms = [];
  x.xmlrpcCall = async (url, method, params) => {
    calls.push({ method, params });
    const [, lcode] = params;
    switch (method) {
      case "get_channels_info": return [0, { 2: { name: "Booking.com" }, 3: { name: "Expedia" }, 46: { name: "Airbnb" } }];
      case "new_ota": return [0, 77];
      case "bcom_start_procedure": return [0, ""];
      case "exp_start_procedure": return [0, ""];
      case "bcom_confirm_activation": return approved ? [0, ""] : [3, "Channel not yet confirmed by the property"];
      case "bcom_init_channel": return [0, ""];
      case "bcom_rooms_rates": return [0, { rooms: [{ id: 9001, name: "Deluxe Ocean", occupancy: 2, units: 4, rates: [{ id: 51, name: "Standard" }] }, { id: 9002, name: "Family Villa", occupancy: 4, units: 2, rates: [{ id: 52, name: "Standard" }] }] }];
      case "new_room": { const id = 300 + wbRooms.length; wbRooms.push({ id, name: params[3], occupancy: params[4], availability: params[6], price: params[5], shortname: params[7], subroom: 0 }); return [0, id]; }
      case "fetch_rooms": return [0, wbRooms];
      case "bcom_set_room_mapping": return [0, ""];
      case "bcom_set_rate_mapping": return [0, ""];
      case "get_otas": return [0, approved ? [{ id: 77, tag: "Booking.com" }] : []];
      case "push_activation": return [0, ""];
      default: return [1, "unexpected " + method];
    }
  };

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const ctrl = require("../src/controllers/hotelController");
  const wubook = require("../src/services/channels/wubookService");

  let ws;
  try {
    ws = await Workspace.create({ name: "Zero Touch Villa " + Date.now(), owner: new mongoose.Types.ObjectId(), industry: "hospitality", subscription: { plan: "hotel_pro", status: "active" } });
    await Property.create({ workspaceId: ws._id, name: "Zero Touch Villa", currency: "USD" });
    const req = (body = {}) => ({ body, query: {}, workspace: ws });

    console.log("\n1. Hotelier enters only the Booking.com hotel ID");
    let r = resMock();
    await ctrl.startWubookSite(req({ ota: "booking_com", otaHotelId: "1234567" }), r, (e) => { throw e; });
    ok(r.body?.success, "connection started", r.body);
    let p = await Property.findOne({ workspaceId: ws._id }).lean();
    ok(p.channel.wubookLcode === "5001", "WuBook property assigned automatically from the pool", p.channel.wubookLcode);
    ok(calls.some((c) => c.method === "new_ota" && c.params[2] === 2), "Booking.com site added to WuBook (ctype from catalogue)");
    ok(calls.some((c) => c.method === "bcom_start_procedure" && c.params[3] === 1234567), "Booking.com procedure started with the hotel ID");
    const site = p.channel.wubookOnboarding.find((o) => o.ota === "booking_com");
    ok(site?.state === "awaiting_approval" && /extranet/i.test(site.message), "hotel told the one click left", site?.message);

    console.log("\n2. Not approved yet → keeps waiting, nothing mapped");
    await wubook.advanceOnboarding();
    p = await Property.findOne({ workspaceId: ws._id }).lean();
    ok(p.channel.wubookOnboarding.find((o) => o.ota === "booking_com").state === "awaiting_approval", "still waiting");
    ok(!calls.some((c) => c.method === "bcom_set_room_mapping"), "no mapping before approval");

    console.log("\n3. Hotel approves on Booking.com → everything else is automatic");
    approved = true;
    r = resMock();
    await ctrl.checkWubookSites(req(), r, (e) => { throw e; });
    p = await Property.findOne({ workspaceId: ws._id }).lean();
    const live = p.channel.wubookOnboarding.find((o) => o.ota === "booking_com");
    ok(live.state === "live", "Booking.com live", live);
    ok(wbRooms.length === 2 && wbRooms.every((w) => w.shortname && w.shortname.length <= 4), "WuBook rooms created from Booking.com's rooms", wbRooms);
    const rm = calls.find((c) => c.method === "bcom_set_room_mapping");
    ok(rm && rm.params[3]["9001"] === 300 && rm.params[3]["9002"] === 301, "Booking.com rooms mapped to WuBook rooms", rm?.params[3]);
    const ratem = calls.find((c) => c.method === "bcom_set_rate_mapping");
    ok(ratem && ratem.params[3]["51"] === 0 && ratem.params[3]["52"] === 0, "rates mapped to the default plan");
    const rooms = await RoomType.find({ propertyId: p._id }).lean();
    ok(rooms.length === 2 && rooms.every((t) => t.wubookRoomId), "rooms imported into Botlify", rooms.map((t) => t.name));
    ok(p.channel.provider === "wubook" && p.channel.connectedOtas.includes("booking_com"), "property live on WuBook with Booking.com");

    console.log("\n4. Second site reuses the same rooms; Airbnb asks for the host login");
    r = resMock();
    await ctrl.startWubookSite(req({ ota: "airbnb" }), r, (e) => { throw e; });
    ok(r.body?.site?.state === "needs_host_login", "Airbnb → one-time host login", r.body?.site?.state);
    r = resMock();
    await ctrl.startWubookSite(req({ ota: "booking_com", otaHotelId: "abc" }), r, () => {}).catch(() => {});
    let rejected = false;
    try { await wubook.startSiteConnection(p, { ota: "booking_com", otaHotelId: "abc" }); } catch { rejected = true; }
    ok(rejected, "bad hotel ID rejected with a clear message");
    ok(wubook._shortName("Deluxe Ocean", new Set(["DEL"])) !== "DEL", "short room names stay unique");
  } catch (e) { fail++; console.log("  ERROR:", e.message, e.stack); }
  finally {
    if (ws) await Promise.all([RoomType.deleteMany({ workspaceId: ws._id }), Property.deleteMany({ workspaceId: ws._id }), Workspace.deleteMany({ _id: ws._id })]).catch(() => {});
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
