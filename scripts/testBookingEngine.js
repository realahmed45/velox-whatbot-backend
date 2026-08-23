/**
 * Booking-engine smoke test — the money path.
 *
 * Exercises the availability math and the commission rules against a real DB
 * (uses a throwaway workspace id, cleans up after itself):
 *   1. availability respects unitsCount and per-night overlap
 *   2. checkout day frees the room for the next guest (no false conflict)
 *   3. a bot booking takes 10% and writes a ledger entry
 *   4. an OTA booking takes 0% and is idempotent on re-delivery
 *   5. overbooking is refused
 *   6. cancelling voids the ledger entry
 *
 * Run: node scripts/testBookingEngine.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const CommissionEntry = require("../src/models/CommissionEntry");
  const { getAvailableUnits } = require("../src/services/hotel/availability");
  const {
    createBooking, ingestOtaBooking, cancelBooking,
  } = require("../src/services/hotel/bookingService");

  const wsId = new mongoose.Types.ObjectId();
  const workspace = { _id: wsId, timezone: "Asia/Makassar", features: { hotelBookings: true } };

  const property = await Property.create({
    workspaceId: wsId, name: "TEST Villa", currency: "USD", email: "",
  });
  const room = await RoomType.create({
    workspaceId: wsId, propertyId: property._id, name: "Deluxe",
    unitsCount: 2, baseRate: 100, currency: "USD",
  });

  const day = (n) => {
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n); return d;
  };

  try {
    console.log("\n1. Empty room shows full inventory");
    let a = await getAvailableUnits(room, day(10), day(13));
    ok(a.ok && a.available === 2 && a.nights === 3, `2 units free, 3 nights (got ${a.available}/${a.nights})`);

    console.log("\n2. Bot booking: 10% commission + ledger entry");
    const r1 = await createBooking({
      workspace, roomTypeId: room._id, checkIn: day(10), checkOut: day(13),
      guestName: "Test Guest", guestPhone: "+62811", source: "whatsapp",
    });
    ok(r1.ok, "booking created");
    ok(r1.booking?.totalAmount === 300, `total 3 nights x100 = 300 (got ${r1.booking?.totalAmount})`);
    ok(r1.booking?.commission?.amount === 30, `commission 10% = 30 (got ${r1.booking?.commission?.amount})`);
    const led = await CommissionEntry.findOne({ bookingId: r1.booking._id, kind: "platform_revenue" });
    ok(!!led && led.amount === 30 && led.status === "accrued", "ledger entry written (accrued, 30)");

    console.log("\n3. Availability decremented for those nights");
    a = await getAvailableUnits(room, day(10), day(13));
    ok(a.available === 1, `1 unit left (got ${a.available})`);

    console.log("\n4. Checkout day is free for the next guest");
    a = await getAvailableUnits(room, day(13), day(15));
    ok(a.available === 2, `both units free from checkout day (got ${a.available})`);

    console.log("\n5. OTA booking: 0% commission, idempotent");
    const otaArgs = {
      property, roomType: room, otaReservationId: "TEST-OTA-1", source: "booking_com",
      checkIn: day(10), checkOut: day(12), guestName: "OTA Guest", totalAmount: 250,
    };
    const o1 = await ingestOtaBooking(otaArgs);
    const o2 = await ingestOtaBooking(otaArgs); // re-delivery
    ok(o1.ok && o2.ok, "both ingests returned ok");
    ok(String(o1.booking._id) === String(o2.booking._id), "same doc reused (idempotent)");
    ok(o1.booking.commission.amount === 0, `OTA commission is 0 (got ${o1.booking.commission.amount})`);
    const otaCount = await HotelBooking.countDocuments({ otaReservationId: "TEST-OTA-1" });
    ok(otaCount === 1, `exactly 1 OTA booking stored (got ${otaCount})`);

    console.log("\n6. Overbooking refused");
    a = await getAvailableUnits(room, day(10), day(12));
    ok(a.available === 0, `sold out for those nights (got ${a.available})`);
    const r3 = await createBooking({
      workspace, roomTypeId: room._id, checkIn: day(10), checkOut: day(12),
      guestName: "Too Late", source: "instagram",
    });
    ok(!r3.ok && r3.reason === "no_availability", `refused with no_availability (got ${r3.reason})`);

    console.log("\n7. Past dates refused");
    const r4 = await createBooking({
      workspace, roomTypeId: room._id, checkIn: day(-5), checkOut: day(-2),
      guestName: "Time Traveller", source: "whatsapp",
    });
    ok(!r4.ok && r4.reason === "past_date", `refused with past_date (got ${r4.reason})`);

    console.log("\n8. Cancelling frees inventory and voids the ledger");
    await cancelBooking(r1.booking._id, { reason: "test", workspaceId: wsId });
    a = await getAvailableUnits(room, day(12), day(13));
    ok(a.available === 2, `inventory returned (got ${a.available})`);
    const voided = await CommissionEntry.findById(led._id);
    ok(voided.status === "void", `ledger entry voided (got ${voided.status})`);
  } catch (e) {
    fail++; console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    await Promise.all([
      HotelBooking.deleteMany({ workspaceId: wsId }),
      CommissionEntry.deleteMany({ workspaceId: wsId }),
      RoomType.deleteMany({ workspaceId: wsId }),
      Property.deleteMany({ workspaceId: wsId }),
      Workspace.deleteMany({ _id: wsId }),
    ]);
    console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
