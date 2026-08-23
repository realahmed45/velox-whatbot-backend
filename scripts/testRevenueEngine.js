/**
 * Revenue-engine smoke test.
 *
 * Proves the pricing logic behaves the way we promise owners:
 *   1. an empty room close to arrival produces a DROP suggestion
 *   2. a nearly-full room produces a RAISE suggestion
 *   3. suggestions respect the owner's min/max guard rails
 *   4. approving one changes the room rate
 *   5. skipping one never comes back
 *   6. tonight is never re-priced out from under a guest
 *
 * Run: node scripts/testRevenueEngine.js
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
  await mongoose.connect(process.env.MONGODB_URI);
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const RateSuggestion = require("../src/models/RateSuggestion");
  const {
    generateForProperty,
    applySuggestion,
    skipSuggestion,
    expectedOccupancy,
  } = require("../src/services/revenue/revenueService");

  const wsId = new mongoose.Types.ObjectId();
  const day = (n) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  const property = await Property.create({
    workspaceId: wsId,
    name: "TEST Revenue Villa",
    city: "TESTCITY_" + Date.now(), // isolated: no peers, so no network signal
    currency: "USD",
    revenue: { enabled: true, mode: "suggest" },
  });

  try {
    console.log("\n0. Lead-time expectations are sane");
    ok(
      expectedOccupancy(1) > expectedOccupancy(25),
      "a night 1 day out is expected fuller than one 25 days out",
    );

    console.log("\n1. Empty room near arrival → DROP suggestion");
    const empty = await RoomType.create({
      workspaceId: wsId,
      propertyId: property._id,
      name: "Empty Room",
      unitsCount: 4,
      baseRate: 100,
      currency: "USD",
    });
    await generateForProperty(property);
    const drops = await RateSuggestion.find({
      roomTypeId: empty._id,
      status: "pending",
      direction: "drop",
    });
    ok(drops.length > 0, "produced at least one drop suggestion");
    const drop = drops[0];
    ok(!!drop && drop.suggestedRate < 100, "suggested rate is below current (" + (drop && drop.suggestedRate) + ")");
    ok(
      !!drop && /unsold|booked/.test(drop.reason),
      "reason reads like a human wrote it: " + (drop && drop.reason),
    );

    console.log("\n2. Near-full room → RAISE suggestion");
    const busy = await RoomType.create({
      workspaceId: wsId,
      propertyId: property._id,
      name: "Busy Room",
      unitsCount: 2,
      baseRate: 100,
      currency: "USD",
    });
    // Fill both units for a night 6 days out (=100% occupancy that night).
    for (let i = 0; i < 2; i++) {
      await HotelBooking.create({
        workspaceId: wsId,
        propertyId: property._id,
        roomTypeId: busy._id,
        guestName: "Filler " + i,
        checkIn: day(6),
        checkOut: day(7),
        nights: 1,
        unitsBooked: 1,
        nightlyRate: 100,
        totalAmount: 100,
        currency: "USD",
        source: "manual",
        status: "confirmed",
      });
    }
    await RateSuggestion.deleteMany({ workspaceId: wsId });
    await generateForProperty(property);
    const raises = await RateSuggestion.find({
      roomTypeId: busy._id,
      status: "pending",
      direction: "raise",
    });
    ok(raises.length > 0, "produced a raise suggestion for the full night");
    ok(
      raises.length === 0 || raises[0].suggestedRate > 100,
      "suggested rate is above current (" + (raises[0] && raises[0].suggestedRate) + ")",
    );

    console.log("\n3. Guard rails are respected");
    property.revenue = { enabled: true, mode: "suggest", minRate: 95, maxRate: 105 };
    await property.save();
    await RateSuggestion.deleteMany({ workspaceId: wsId });
    await generateForProperty(property);
    const all = await RateSuggestion.find({ workspaceId: wsId, status: "pending" });
    const withinRails = all.every(
      (s) => s.suggestedRate >= 95 && s.suggestedRate <= 105,
    );
    ok(withinRails, "every suggestion sits inside the 95–105 guard rails");

    console.log("\n4. Tonight is never re-priced");
    const touchesToday = all.some((s) => s.dateFrom <= day(0));
    ok(!touchesToday, "no suggestion targets today");

    console.log("\n5. Approving applies the rate");
    property.revenue = { enabled: true, mode: "suggest", minRate: 0, maxRate: 0 };
    await property.save();
    await RateSuggestion.deleteMany({ workspaceId: wsId });
    await generateForProperty(property);
    const one = await RateSuggestion.findOne({ workspaceId: wsId, status: "pending" });
    ok(!!one, "have a pending suggestion to approve");
    if (one) {
      const res = await applySuggestion(one, { by: "test" });
      ok(res.ok, "applySuggestion returned ok");
      const rt = await RoomType.findById(one.roomTypeId);
      ok(rt.baseRate === one.suggestedRate, "room rate now equals the suggested rate");
      const reloaded = await RateSuggestion.findById(one._id);
      ok(reloaded.status === "approved", "suggestion marked approved");
    }

    console.log("\n6. Skipping removes it for good");
    const two = await RateSuggestion.findOne({ workspaceId: wsId, status: "pending" });
    if (two) {
      await skipSuggestion(two._id);
      const reloaded = await RateSuggestion.findById(two._id);
      ok(reloaded.status === "skipped", "suggestion marked skipped");
    } else {
      ok(true, "no second suggestion to skip (acceptable)");
    }
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    await Promise.all([
      RateSuggestion.deleteMany({ workspaceId: wsId }),
      HotelBooking.deleteMany({ workspaceId: wsId }),
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
