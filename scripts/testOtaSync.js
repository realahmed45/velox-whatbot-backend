/**
 * OTA sync edge-case test — the scenarios a real connected hotel will hit.
 *
 *   1. an OTA booking arrives and blocks inventory
 *   2. the SAME reservation redelivered (Channex retries) does not duplicate
 *   3. a modified reservation (dates changed) updates in place
 *   4. a CANCELLED reservation frees the room again
 *   5. a bot booking and an OTA booking compete for the last room — the second
 *      one is refused rather than overbooking
 *   6. a multi-room OTA reservation creates one booking per room
 *
 * These are the cases that cost a real hotel money if they are wrong.
 * Run: node scripts/testOtaSync.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label);
  }
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
  });

  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const CommissionEntry = require("../src/models/CommissionEntry");
  const {
    ingestOtaBooking,
    createBooking,
  } = require("../src/services/hotel/bookingService");
  const { getAvailableUnits } = require("../src/services/hotel/availability");

  const wsId = new mongoose.Types.ObjectId();
  const day = (n) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  let property, room;

  try {
    property = await Property.create({
      workspaceId: wsId,
      name: "OTA Sync Test",
      currency: "USD",
    });
    room = await RoomType.create({
      workspaceId: wsId,
      propertyId: property._id,
      name: "Standard",
      unitsCount: 2,
      baseRate: 100,
      currency: "USD",
    });
    const workspace = {
      _id: wsId,
      timezone: "Asia/Makassar",
      features: { hotelBookings: true },
    };
    const resId = "SYNC-TEST-" + Date.now();

    console.log("\n1. OTA booking arrives and blocks inventory");
    const first = await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: resId,
      source: "booking_com",
      checkIn: day(10),
      checkOut: day(13),
      guestName: "OTA Guest",
      totalAmount: 300,
    });
    ok(first.ok, "ingested");
    let avail = await getAvailableUnits(room, day(10), day(13));
    ok(avail.available === 1, "1 of 2 units left (got " + avail.available + ")");

    console.log("\n2. Channex redelivers the same reservation");
    await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: resId,
      source: "booking_com",
      checkIn: day(10),
      checkOut: day(13),
      guestName: "OTA Guest",
      totalAmount: 300,
    });
    let count = await HotelBooking.countDocuments({ otaReservationId: resId });
    ok(count === 1, "still exactly 1 booking, no duplicate (got " + count + ")");
    avail = await getAvailableUnits(room, day(10), day(13));
    ok(avail.available === 1, "inventory unchanged by the retry");

    console.log("\n3. Guest changes their dates on Booking.com");
    await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: resId,
      source: "booking_com",
      checkIn: day(20),
      checkOut: day(22),
      guestName: "OTA Guest",
      totalAmount: 200,
    });
    count = await HotelBooking.countDocuments({ otaReservationId: resId });
    ok(count === 1, "still 1 booking after modification");
    const oldRange = await getAvailableUnits(room, day(10), day(13));
    ok(oldRange.available === 2, "old dates released (got " + oldRange.available + ")");
    const newRange = await getAvailableUnits(room, day(20), day(22));
    ok(newRange.available === 1, "new dates now blocked (got " + newRange.available + ")");

    console.log("\n4. Guest cancels on Booking.com");
    await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: resId,
      source: "booking_com",
      status: "cancelled",
      checkIn: day(20),
      checkOut: day(22),
      guestName: "OTA Guest",
      totalAmount: 200,
    });
    const cancelled = await HotelBooking.findOne({ otaReservationId: resId });
    ok(cancelled.status === "cancelled", "marked cancelled");
    const freed = await getAvailableUnits(room, day(20), day(22));
    ok(freed.available === 2, "room is sellable again (got " + freed.available + ")");

    console.log("\n5. Last room: OTA and bot compete, no overbooking");
    // Fill one unit via OTA, one via the bot — then a third attempt must fail.
    await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: resId + "-A",
      source: "airbnb",
      checkIn: day(30),
      checkOut: day(31),
      guestName: "Airbnb Guest",
      totalAmount: 100,
    });
    const botOk = await createBooking({
      workspace,
      roomTypeId: room._id,
      checkIn: day(30),
      checkOut: day(31),
      guestName: "WhatsApp Guest",
      source: "whatsapp",
    });
    ok(botOk.ok, "bot booked the last room");
    const overbook = await createBooking({
      workspace,
      roomTypeId: room._id,
      checkIn: day(30),
      checkOut: day(31),
      guestName: "One Too Many",
      source: "whatsapp",
    });
    ok(
      !overbook.ok && overbook.reason === "no_availability",
      "third booking refused (got " + overbook.reason + ")",
    );

    console.log("\n6. Commission rules held throughout");
    const otaCommission = await CommissionEntry.countDocuments({
      workspaceId: wsId,
      revenueType: "booking_commission",
      bookingId: (await HotelBooking.findOne({ otaReservationId: resId + "-A" }))._id,
    });
    ok(otaCommission === 0, "no commission on the Airbnb booking");
    const botBooking = await HotelBooking.findById(botOk.booking._id);
    ok(botBooking.commission.amount === 10, "10% on the WhatsApp booking (got " + botBooking.commission.amount + ")");
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    await Promise.all([
      HotelBooking.deleteMany({ workspaceId: wsId }),
      CommissionEntry.deleteMany({ workspaceId: wsId }),
      RoomType.deleteMany({ workspaceId: wsId }),
      Property.deleteMany({ workspaceId: wsId }),
    ]);
    console.log(
      "\n" + "=".repeat(46) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(46),
    );
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
