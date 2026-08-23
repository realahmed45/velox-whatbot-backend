/**
 * End-to-end v2 flow test.
 *
 * Walks one hotel through a realistic day and proves the new systems work
 * TOGETHER, not just individually:
 *   1. a new property arrives complete (upsells seeded, public slug, revenue on)
 *   2. a guest books via WhatsApp → 10% commission in the ledger
 *   3. the same guest becomes ONE unified Guest profile
 *   4. an OTA booking for the same person merges into that profile (0% commission)
 *   5. that guest becomes directEligible (OTA stay + first-party contact)
 *   6. an upsell is accepted → folio line + its own 10% ledger entry
 *   7. front desk: check in → unit assigned; check out → unit dirty, folio totalled
 *   8. a review is ingested and normalized
 *   9. the agent's read-only tools return real numbers
 *
 * Run: node scripts/testV2Flow.js
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

  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const CommissionEntry = require("../src/models/CommissionEntry");
  const Guest = require("../src/models/Guest");
  const Upsell = require("../src/models/Upsell");
  const Review = require("../src/models/Review");

  const { createBooking, ingestOtaBooking } = require("../src/services/hotel/bookingService");
  const guestService = require("../src/services/hotel/guestService");
  const upsellService = require("../src/services/hotel/upsellService");
  const reviewService = require("../src/services/reputation/reviewService");
  const { runTool } = require("../src/services/agent/tools");

  const wsId = new mongoose.Types.ObjectId();
  const day = (n) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  let property, room, booking, otaBooking;

  try {
    console.log("\n1. A new property arrives ready to use");
    property = await Property.create({
      workspaceId: wsId,
      name: "E2E Test Hotel",
      city: "E2ECITY_" + Date.now(),
      currency: "USD",
    });
    ok(property.upsells.length === 5, "5 upsells seeded (" + property.upsells.length + ")");
    ok(!!property.directBooking.slug, "public booking slug: " + property.directBooking.slug);
    ok(property.revenue.mode === "suggest", "revenue starts in suggest mode");

    room = await RoomType.create({
      workspaceId: wsId,
      propertyId: property._id,
      name: "Garden Suite",
      unitsCount: 3,
      baseRate: 120,
      currency: "USD",
    });

    const workspace = { _id: wsId, timezone: "Asia/Makassar", features: { hotelBookings: true } };

    console.log("\n2. Guest books over WhatsApp → 10% commission");
    const r = await createBooking({
      workspace,
      roomTypeId: room._id,
      checkIn: day(3),
      checkOut: day(6),
      guestName: "Rina Wijaya",
      guestPhone: "+62 812 3456 7890", // stored as typed, on purpose
      guestEmail: "rina@example.com",
      source: "whatsapp",
    });
    ok(r.ok, "booking created");
    booking = r.booking;
    ok(booking.totalAmount === 360, "total 3 nights x120 = 360 (got " + booking.totalAmount + ")");
    ok(booking.commission.amount === 36, "commission 36 (got " + booking.commission.amount + ")");

    console.log("\n3. Guest profile is created and unified");
    await guestService.upsertGuestFromBooking(booking);
    let guest = await Guest.findOne({ workspaceId: wsId });
    ok(!!guest, "guest profile created");
    ok(
      guest && guest.stats.staysCount === 1,
      "1 stay counted despite the spaced phone format (got " + (guest && guest.stats.staysCount) + ")",
    );
    ok(guest && guest.stats.nightsTotal === 3, "3 nights totalled");

    console.log("\n4. Same person books again via Booking.com → merges, 0% commission");
    const o = await ingestOtaBooking({
      property,
      roomType: room,
      otaReservationId: "E2E-OTA-" + Date.now(),
      source: "booking_com",
      checkIn: day(20),
      checkOut: day(22),
      guestName: "Rina Wijaya",
      guestPhone: "0812-3456-7890", // same number, different formatting
      totalAmount: 300,
    });
    ok(o.ok, "OTA booking ingested");
    otaBooking = o.booking;
    ok(otaBooking.commission.amount === 0, "OTA commission is 0");
    await guestService.upsertGuestFromBooking(otaBooking);
    const guests = await Guest.find({ workspaceId: wsId });
    ok(guests.length === 1, "still ONE guest profile, not two (got " + guests.length + ")");
    guest = guests[0];
    ok(guest.stats.staysCount === 2, "2 stays now (got " + guest.stats.staysCount + ")");

    console.log("\n5. Guest is direct-eligible (OTA stay + first-party chat)");
    ok(
      guest.directEligible === true,
      "directEligible true (OTA stay + WhatsApp identity)",
    );

    console.log("\n6. Upsell accepted → folio line + its own 10% commission");
    const prop = await Property.findById(property._id);
    const bf = prop.upsells.find((u) => u.key === "breakfast");
    bf.price = 20;
    await prop.save();
    const acc = await upsellService.acceptUpsell({
      workspace,
      bookingId: booking._id,
      key: "breakfast",
      quantity: 2,
    });
    ok(acc.ok, "upsell accepted");
    const up = await Upsell.findOne({ bookingId: booking._id });
    ok(up && up.status === "accepted", "upsell row marked accepted");
    const withFolio = await HotelBooking.findById(booking._id);
    ok(
      withFolio.folio && withFolio.folio.length === 1,
      "folio line added (" + (withFolio.folio || []).length + ")",
    );
    const upsellLedger = await CommissionEntry.findOne({
      bookingId: booking._id,
      reference: /upsell/,
    });
    ok(
      !!upsellLedger && upsellLedger.amount === 4,
      "upsell commission 10% of 40 = 4 (got " + (upsellLedger && upsellLedger.amount) + ")",
    );

    console.log("\n7. Front desk: check in, then check out");
    const ci = await runTool(
      "check_in_guest",
      { code: booking.code, unit: "G1" },
      { workspace },
    );
    ok(ci.checkedIn === true, "checked in via agent tool");
    const co = await runTool("check_out_guest", { code: booking.code }, { workspace });
    ok(co.checkedOut === true, "checked out");
    ok(co.extras === 40, "folio extras 40 carried to checkout (got " + co.extras + ")");
    ok(co.total === 400, "grand total 360 + 40 = 400 (got " + co.total + ")");

    console.log("\n8. Review ingested and normalized");
    const rev = await reviewService.ingestReview({
      workspaceId: wsId,
      propertyId: property._id,
      source: "booking_com",
      externalId: "E2E-REV-" + Date.now(),
      guestName: "Rina Wijaya",
      rating: 9,
      ratingScale: 10,
      text: "Lovely stay, staff were wonderful.",
      reviewedAt: new Date(),
    });
    ok(rev && (rev.ok !== false), "review ingested");
    const savedReview = await Review.findOne({ workspaceId: wsId });
    ok(savedReview && savedReview.stars >= 4, "9/10 normalized to " + (savedReview && savedReview.stars) + " stars");
    ok(savedReview && savedReview.sentiment === "positive", "sentiment positive");

    console.log("\n9. Agent tools return real data");
    const occ = await runTool("get_occupancy", { days: 7 }, { workspace });
    ok(Array.isArray(occ.nights) && occ.nights.length === 7, "occupancy returns 7 nights");
    const revenue = await runTool("get_revenue", { upcoming: true }, { workspace });
    ok(
      Array.isArray(revenue.bySource) && revenue.bySource.length > 0,
      "upcoming revenue broken down by source",
    );
    const g = await runTool("get_guest", { query: "Rina" }, { workspace });
    ok(g.guests && g.guests.length === 1 && g.guests[0].stays === 2, "agent finds the unified guest with 2 stays");
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    await Promise.all([
      HotelBooking.deleteMany({ workspaceId: wsId }),
      CommissionEntry.deleteMany({ workspaceId: wsId }),
      Guest.deleteMany({ workspaceId: wsId }),
      Upsell.deleteMany({ workspaceId: wsId }),
      Review.deleteMany({ workspaceId: wsId }),
      RoomType.deleteMany({ workspaceId: wsId }),
      Property.deleteMany({ workspaceId: wsId }),
      Workspace.deleteMany({ _id: wsId }),
    ]);
    console.log(
      "\n" + "=".repeat(46) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(46),
    );
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
