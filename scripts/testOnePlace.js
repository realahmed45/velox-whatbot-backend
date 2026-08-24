/**
 * "All bookings in one place" — the core promise, proven end to end.
 *
 * A hotel with one room type and 2 physical rooms. Bookings arrive from
 * Booking.com, from Airbnb, and from a guest chatting on WhatsApp. The point of
 * Botlify is that every one of those writes to the SAME calendar, so:
 *
 *   - the AI never offers a night an OTA already sold
 *   - an OTA can never sell a night the AI already booked
 *   - a cancellation anywhere frees the room everywhere
 *
 * Run: node scripts/testOnePlace.js
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
const say = (s) => console.log("\n" + s);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
  });

  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const CommissionEntry = require("../src/models/CommissionEntry");
  const {
    createBooking,
    ingestOtaBooking,
    cancelBooking,
  } = require("../src/services/hotel/bookingService");
  const { getAvailableUnits } = require("../src/services/hotel/availability");
  const { buildHotelBlock } = require("../src/services/ai/hotelBlock");

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
      name: "One Place Villa",
      city: "ONEPLACE_" + Date.now(),
      currency: "USD",
    });
    room = await RoomType.create({
      workspaceId: wsId,
      propertyId: property._id,
      name: "Deluxe Double",
      unitsCount: 2, // TWO physical rooms
      baseRate: 100,
      currency: "USD",
    });
    const workspace = {
      _id: wsId,
      timezone: "Asia/Makassar",
      features: { hotelBookings: true },
    };

    say("The hotel has 2 Deluxe Double rooms. Nights 10-12 are open.");
    let a = await getAvailableUnits(room, day(10), day(12));
    ok(a.available === 2, "both rooms free (" + a.available + ")");

    say("1. A guest books on BOOKING.COM.");
    const bcom = await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: "BCOM-" + Date.now(),
      source: "booking_com",
      checkIn: day(10),
      checkOut: day(12),
      guestName: "Booking.com Guest",
      totalAmount: 200,
    });
    ok(bcom.ok, "reservation synced into Botlify");
    a = await getAvailableUnits(room, day(10), day(12));
    ok(a.available === 1, "1 room left — the calendar already knows (" + a.available + ")");
    ok(bcom.booking.commission.amount === 0, "0% commission on the OTA booking");

    say("2. Another guest books the SAME nights on AIRBNB.");
    const abnb = await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: "ABNB-" + Date.now(),
      source: "airbnb",
      checkIn: day(10),
      checkOut: day(12),
      guestName: "Airbnb Guest",
      totalAmount: 210,
    });
    ok(abnb.ok, "reservation synced into Botlify");
    a = await getAvailableUnits(room, day(10), day(12));
    ok(a.available === 0, "hotel is now FULL for those nights (" + a.available + ")");

    say("3. A guest messages on WHATSAPP asking for the same nights.");
    say("   The AI reads the live calendar — it must NOT offer a sold-out night.");
    const block = await buildHotelBlock({
      _id: wsId,
      features: { hotelBookings: true },
    });
    // The AI is given only the FREE ranges and told to offer nothing outside
    // them, so a sold-out night simply isn't listed. Assert that directly:
    // the sold-out window must not appear as bookable.
    const availLine =
      (block.split("AVAILABILITY")[1] || "").split("TO BOOK")[0] || "";
    const soldOutDay = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(day(10));
    ok(
      !availLine.includes(soldOutDay) || /fully booked/i.test(availLine),
      "the sold-out night is NOT offered to the AI (" + soldOutDay + ")",
    );

    const tooLate = await createBooking({
      workspace,
      roomTypeId: room._id,
      checkIn: day(10),
      checkOut: day(12),
      guestName: "WhatsApp Guest",
      source: "whatsapp",
    });
    ok(
      !tooLate.ok && tooLate.reason === "no_availability",
      "the AI is REFUSED — no double-booking (" + tooLate.reason + ")",
    );

    say("4. The Booking.com guest CANCELS.");
    await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: bcom.booking.otaReservationId,
      source: "booking_com",
      status: "cancelled",
      checkIn: day(10),
      checkOut: day(12),
      guestName: "Booking.com Guest",
      totalAmount: 200,
    });
    a = await getAvailableUnits(room, day(10), day(12));
    ok(a.available === 1, "that room is instantly sellable again (" + a.available + ")");

    say("5. Now the WhatsApp guest CAN book — the AI sells the freed room.");
    const nowOk = await createBooking({
      workspace,
      roomTypeId: room._id,
      checkIn: day(10),
      checkOut: day(12),
      guestName: "WhatsApp Guest",
      source: "whatsapp",
    });
    ok(nowOk.ok, "AI booked the room the OTA gave back");
    ok(
      nowOk.booking.commission.amount === 20,
      "10% commission — we earned this one (" + nowOk.booking.commission.amount + ")",
    );
    a = await getAvailableUnits(room, day(10), day(12));
    ok(a.available === 0, "full again — every channel sees the same truth");

    say("6. One calendar, three sources.");
    const all = await HotelBooking.find({
      workspaceId: wsId,
      status: { $in: ["pending", "confirmed"] },
    }).lean();
    const sources = all.map((b) => b.source).sort();
    ok(all.length === 2, "2 live bookings (" + all.length + ")");
    ok(
      sources.includes("airbnb") && sources.includes("whatsapp"),
      "from different channels, one place: " + sources.join(" + "),
    );
    const earned = await CommissionEntry.aggregate([
      { $match: { workspaceId: wsId, kind: "platform_revenue", status: "accrued" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    ok(
      (earned[0]?.total || 0) === 20,
      "we charge ONLY for what the AI sold: $" + (earned[0]?.total || 0),
    );
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
      "\n" + "=".repeat(52) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(52),
    );
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
