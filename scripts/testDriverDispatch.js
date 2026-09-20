/**
 * Driver dispatch — "ask driver one, wait ten minutes, then ask the next".
 *
 * The promise to the hotel is that a guest always ends up with a driver's
 * number, without anyone watching a screen. That only holds if the rotation
 * really advances on silence, really stops on acceptance, and never puts two
 * drivers on one car. Those are the things worth a test.
 *
 * Run: node scripts/testDriverDispatch.js
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

  const Driver = require("../src/models/Driver");
  const TransferBooking = require("../src/models/TransferBooking");
  const Property = require("../src/models/Property");
  const dispatch = require("../src/services/transfers/dispatchService");

  const wsId = new mongoose.Types.ObjectId();
  const tag = "DISPATCH_" + Date.now();
  let property, drivers = [], transfer;

  const mkTransfer = async () =>
    TransferBooking.create({
      workspaceId: wsId,
      propertyId: property._id,
      direction: "pickup",
      guestName: "Test Guest",
      guestPhone: "+628111222333",
      passengers: 2,
      pickupAt: new Date(Date.now() + 86400000),
      provider: "platform",
      status: "pending",
      dispatch: { state: "searching" },
    });

  try {
    property = await Property.create({
      workspaceId: wsId,
      name: "Dispatch Test Hotel",
      city: tag,
      currency: "USD",
      // No own taxi service → draw from the platform pool.
      transfers: { hasOwnService: false },
    });

    // Three platform drivers, in a known order.
    for (let i = 1; i <= 3; i++) {
      drivers.push(
        await Driver.create({
          scope: "platform",
          name: `Driver ${i} ${tag}`,
          phone: `+62811000000${i}`,
          priority: i, // deterministic rotation order
          active: true,
        }),
      );
    }

    say("A pickup comes in. Driver 1 is asked first.");
    transfer = await mkTransfer();
    let r = await dispatch.offerNext(transfer._id);
    ok(r.ok, "an offer went out");
    ok(
      String(r.driverId) === String(drivers[0]._id),
      "driver 1 got it (lowest priority number)",
    );

    say("A second call must NOT stack another offer on the same job.");
    r = await dispatch.offerNext(transfer._id);
    ok(r.reason === "offer_pending", "no double offer (" + r.reason + ")");
    transfer = await TransferBooking.findById(transfer._id);
    ok(transfer.dispatch.offers.length === 1, "still exactly one offer");

    say("Driver 1 says nothing for ten minutes.");
    // Wind the clock back rather than waiting — same code path as the sweep.
    transfer.dispatch.offers[0].expiresAt = new Date(Date.now() - 1000);
    await transfer.save();
    await dispatch.sweepExpiredOffers();
    transfer = await TransferBooking.findById(transfer._id);
    ok(
      transfer.dispatch.offers[0].outcome === "timeout",
      "driver 1 is marked as missed",
    );
    ok(
      transfer.dispatch.offers.length === 2 &&
        String(transfer.dispatch.offers[1].driverId) === String(drivers[1]._id),
      "the job moved to driver 2 on its own",
    );

    say("Driver 2 passes. It should go straight on, not wait the clock out.");
    await dispatch.declineOffer({
      transferId: transfer._id,
      driverId: drivers[1]._id,
    });
    transfer = await TransferBooking.findById(transfer._id);
    ok(
      transfer.dispatch.offers[1].outcome === "declined",
      "driver 2 recorded as declined",
    );
    ok(
      transfer.dispatch.offers.length === 3 &&
        String(transfer.dispatch.offers[2].driverId) === String(drivers[2]._id),
      "driver 3 was asked immediately",
    );

    say("Driver 3 accepts. The guest gets their name and number.");
    const acc = await dispatch.acceptOffer({
      transferId: transfer._id,
      driverId: drivers[2]._id,
    });
    ok(acc.ok, "acceptance taken");
    transfer = await TransferBooking.findById(transfer._id);
    ok(transfer.dispatch.state === "assigned", "job is assigned");
    ok(
      String(transfer.driverId) === String(drivers[2]._id),
      "the right driver is on the job",
    );
    ok(
      transfer.driverSnapshot.phone === drivers[2].phone,
      "their number is snapshotted for the guest",
    );
    ok(transfer.status === "confirmed", "transfer is confirmed");
    const handoff = dispatch.guestHandoffText(transfer);
    ok(
      handoff.includes(drivers[2].phone),
      "guest message carries the driver's number",
    );

    say("A late driver must not steal an assigned job.");
    const late = await dispatch.acceptOffer({
      transferId: transfer._id,
      driverId: drivers[0]._id,
    });
    ok(!late.ok && late.reason === "taken", "second acceptance refused");
    transfer = await TransferBooking.findById(transfer._id);
    ok(
      String(transfer.driverId) === String(drivers[2]._id),
      "the original driver keeps the job",
    );

    say("Nobody available → the job is flagged, not silently dropped.");
    await Driver.updateMany(
      { name: { $regex: tag } },
      { $set: { active: false } },
    );
    const lonely = await mkTransfer();
    const none = await dispatch.offerNext(lonely._id);
    ok(!none.ok && none.reason === "exhausted", "reported as exhausted");
    const after = await TransferBooking.findById(lonely._id);
    ok(
      after.dispatch.state === "exhausted" && !!after.dispatch.lastError,
      "state and reason recorded for the hotel: " + after.dispatch.lastError,
    );

    say("A hotel with its own driver never draws from the platform pool.");
    await Driver.updateMany(
      { name: { $regex: tag } },
      { $set: { active: true } },
    );
    const ownDriver = await Driver.create({
      scope: "hotel",
      workspaceId: wsId,
      name: "Hotel Driver " + tag,
      phone: "+628119999999",
      active: true,
    });
    drivers.push(ownDriver);
    property.transfers.hasOwnService = true;
    await property.save();
    const ownJob = await mkTransfer();
    const ownRes = await dispatch.offerNext(ownJob._id);
    ok(
      String(ownRes.driverId) === String(ownDriver._id),
      "their own driver was chosen, not ours",
    );
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    await Promise.all([
      Driver.deleteMany({ $or: [{ name: { $regex: tag } }, { workspaceId: wsId }] }),
      TransferBooking.deleteMany({ workspaceId: wsId }),
      Property.deleteMany({ workspaceId: wsId }),
    ]);
    console.log(
      "\n" + "=".repeat(52) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(52),
    );
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
