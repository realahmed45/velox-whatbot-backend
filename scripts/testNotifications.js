/**
 * Services + notifications: services flow to the website and the AI; bookings,
 * cancellations and guest messages raise bell notifications (deduped).
 * Run: node scripts/testNotifications.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log("  PASS  " + l); } else { fail++; console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const zernio = require("../src/services/channels/zernioSocialService");
  zernio.sendDM = async () => ({ success: true, messageId: "x" });
  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const Notification = require("../src/models/Notification");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const Contact = require("../src/models/Contact");
  const { notify, unreadCount } = require("../src/services/notificationService");
  const { buildSite } = require("../src/services/website/siteBuilder");
  const { buildHotelBlock } = require("../src/services/ai/hotelBlock");
  const { ingestOtaBooking } = require("../src/services/hotel/bookingService");
  const { encrypt } = require("../src/utils/encryption");
  const { hashToken } = require("../src/utils/crypto");

  let ws, prop;
  try {
    ws = await Workspace.create({
      name: "Notify Test Villa " + Date.now(), owner: new mongoose.Types.ObjectId(), industry: "hospitality",
      subscription: { plan: "hotel_pro", status: "active" }, settings: { automationEnabled: true }, features: { hotelBookings: true },
      channels: [{ platform: "whatsapp", provider: "zernio", status: "connected", accountId: encrypt("acc-n"), accountHash: hashToken("acc-n") }],
    });
    prop = await Property.create({
      workspaceId: ws._id, name: "Villa Notify", currency: "USD",
      services: [
        { key: "massage", name: "Massage", description: "In-room massage", price: 25, priceUnit: "per hour", icon: "HandHeart" },
        { key: "airport_pickup", name: "Airport pickup", price: 18, priceUnit: "per trip" },
        { key: "yoga", name: "Yoga", enabled: false },
      ],
    });
    const room = await RoomType.create({ workspaceId: ws._id, propertyId: prop._id, name: "Room 1", unitsCount: 2, baseRate: 100, currency: "USD" });

    console.log("\n1. Services reach the website and the AI");
    const site = buildSite({ slug: "notify", templateId: "coastal", content: {} }, prop.toObject(), [room.toObject()]);
    ok(site.services.length === 2, "enabled services on the website (disabled hidden)", site.services.map((s) => s.name));
    ok(site.services[0].price === 25 && site.services[0].priceUnit === "per hour", "price + unit carried");
    const block = await buildHotelBlock(ws);
    ok(/Massage \(25 USD per hour\)/.test(block) && /Airport pickup/.test(block), "AI knows the services and prices", block.match(/Services[^\n]*/)?.[0]);

    console.log("\n2. Dedupe");
    await notify(ws._id, { type: "message.new", title: "A", dedupeKey: "k1" });
    await notify(ws._id, { type: "message.new", title: "B", dedupeKey: "k1" });
    const rows = await Notification.find({ workspaceId: ws._id, dedupeKey: "k1" }).lean();
    ok(rows.length === 1 && rows[0].title === "B", "repeat refreshes one unread row", rows.map((r) => r.title));

    console.log("\n3. Bookings raise notifications");
    const ci = new Date(Date.now() + 5 * 86400000), co = new Date(Date.now() + 7 * 86400000);
    await ingestOtaBooking({ property: prop, roomType: room, otaReservationId: "N-1", source: "airbnb", status: "confirmed", checkIn: ci, checkOut: co, guestName: "Maya Chen", adults: 2, children: 0, totalAmount: 200, currency: "USD" });
    await wait(400);
    let n = await Notification.findOne({ workspaceId: ws._id, type: "booking.new" }).lean();
    ok(n && /Maya Chen/.test(n.title) && /Airbnb/.test(n.body) && n.channel === "airbnb", "new OTA booking → bell", n);
    await ingestOtaBooking({ property: prop, roomType: room, otaReservationId: "N-1", source: "airbnb", status: "confirmed", checkIn: ci, checkOut: co, guestName: "Maya Chen", adults: 2, children: 0, totalAmount: 200, currency: "USD" });
    ok((await Notification.countDocuments({ workspaceId: ws._id, type: "booking.new" })) === 1, "re-sync of the same booking doesn't notify again");
    await ingestOtaBooking({ property: prop, roomType: room, otaReservationId: "N-1", source: "airbnb", status: "cancelled", checkIn: ci, checkOut: co, guestName: "Maya Chen", adults: 2, children: 0, totalAmount: 200, currency: "USD" });
    await wait(400); // notify() is fire-and-forget so it never slows a booking
    n = await Notification.findOne({ workspaceId: ws._id, type: "booking.cancelled" }).lean();
    ok(n && n.priority === "high", "cancellation → high-priority bell");

    console.log("\n4. Guest message raises one row per conversation");
    const { handleWebhookEvent, TRIGGERS } = require("../src/services/instagram/automationEngine");
    await handleWebhookEvent(ws._id, { type: TRIGGERS.DIRECT_MESSAGE, channel: "whatsapp", senderId: "628111", senderName: "Sofia", text: "Hi there!" });
    await handleWebhookEvent(ws._id, { type: TRIGGERS.DIRECT_MESSAGE, channel: "whatsapp", senderId: "628111", senderName: "Sofia", text: "Is breakfast included?" });
    await wait(500);
    const msgs = await Notification.find({ workspaceId: ws._id, type: "message.new", channel: "whatsapp" }).lean();
    ok(msgs.length === 1 && /Sofia/.test(msgs[0].title) && /breakfast/i.test(msgs[0].body), "one live row, latest message shown", msgs.map((m) => m.body));
    ok(String(msgs[0].link).startsWith("/dashboard/inbox?c="), "deep link to the conversation", msgs[0].link);

    console.log("\n5. Unread count + read");
    const before = await unreadCount(ws._id);
    await Notification.updateMany({ workspaceId: ws._id }, { $set: { readAt: new Date() } });
    ok(before >= 4 && (await unreadCount(ws._id)) === 0, "unread count + mark all read", before);
  } catch (e) { fail++; console.log("  ERROR:", e.message, e.stack); }
  finally {
    if (ws) await Promise.all([Notification.deleteMany({ workspaceId: ws._id }), HotelBooking.deleteMany({ workspaceId: ws._id }), RoomType.deleteMany({ workspaceId: ws._id }), Property.deleteMany({ workspaceId: ws._id }), Message.deleteMany({ workspaceId: ws._id }), Conversation.deleteMany({ workspaceId: ws._id }), Contact.deleteMany({ workspaceId: ws._id }), Workspace.deleteMany({ _id: ws._id })]).catch(() => {});
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
