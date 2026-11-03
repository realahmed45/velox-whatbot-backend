/**
 * Airport pickups — a person assigns the driver, the guest is told.
 *
 * Drivers are contacted by hand, so what has to be right is the bookkeeping
 * around that: a pickup waits for a driver; a hotel can only use its own
 * drivers and the Botlify team only Botlify's; assigning confirms the pickup
 * and produces the message the guest receives; and a finished pickup can't be
 * re-assigned.
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
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  const Driver = require("../src/models/Driver");
  const TransferBooking = require("../src/models/TransferBooking");
  const Property = require("../src/models/Property");
  const { createTransfer } = require("../src/services/transfers/transferService");
  const { assignDriver, guestHandoffText } = require("../src/services/transfers/dispatchService");

  const wsId = new mongoose.Types.ObjectId();
  const otherWs = new mongoose.Types.ObjectId();
  const tag = "ASSIGN_" + Date.now();
  const workspace = { _id: wsId, timezone: "Asia/Makassar" };
  const pickup = { direction: "pickup", pickupAt: new Date(Date.now() + 86400000).toISOString(), guestName: "Test Guest", guestPhone: "+628111222333", passengers: 2, flightNumber: "SQ938" };

  try {
    const property = await Property.create({
      workspaceId: wsId, name: "Assign Test Hotel", city: tag, currency: "USD",
      transfers: { hasOwnService: true, ownServicePrice: 25 },
    });
    const own = await Driver.create({
      scope: "hotel", workspaceId: wsId, name: "Wayan Sudiarta", nickname: "Wayan", phone: "+62 813 3700 1122",
      vehicle: { make: "Toyota", model: "Avanza", colour: "Silver", plate: "DK 1234 AB" },
    });
    const strangers = await Driver.create({ scope: "hotel", workspaceId: otherWs, name: "Other Hotel Driver " + tag, phone: "+62 811 0000 0001" });
    const botlify = await Driver.create({ scope: "platform", name: "Botlify Driver " + tag, phone: "+62 811 0000 0002" });

    say("A guest asks for a pickup at a hotel that runs its own drivers.");
    let r = await createTransfer({ workspace, transfer: pickup, property });
    ok(r.ok, "pickup created");
    ok(r.transfer.provider === "own" && r.transfer.dispatch.state === "searching", "waiting for the hotel to assign a driver");
    ok(/assigning your driver/i.test(r.confirmationText), "guest told a driver is being assigned");

    say("The hotel can't use another hotel's driver, or a Botlify driver.");
    let a = await assignDriver({ transferId: r.transfer._id, driverId: strangers._id, scope: "hotel", workspaceId: wsId });
    ok(!a.ok, "another hotel's driver refused");
    a = await assignDriver({ transferId: r.transfer._id, driverId: botlify._id, scope: "hotel", workspaceId: wsId });
    ok(!a.ok, "Botlify driver refused for the hotel");

    say("The hotel assigns its own driver.");
    a = await assignDriver({ transferId: r.transfer._id, driverId: own._id, scope: "hotel", workspaceId: wsId });
    ok(a.ok, "assigned");
    const t = await TransferBooking.findById(r.transfer._id);
    ok(t.dispatch.state === "assigned" && t.status === "confirmed", "pickup confirmed");
    const msg = guestHandoffText(t);
    ok(/Wayan/.test(msg) && /Silver Toyota Avanza/.test(msg) && /\+62 813 3700 1122/.test(msg), "guest message: " + msg);

    say("A different hotel can't touch this pickup.");
    a = await assignDriver({ transferId: r.transfer._id, driverId: own._id, scope: "hotel", workspaceId: otherWs });
    ok(!a.ok, "refused");

    say("A hotel with no service of its own gets a Botlify driver.");
    property.transfers.hasOwnService = false;
    await property.save();
    r = await createTransfer({ workspace, transfer: pickup, property });
    ok(r.transfer.provider === "platform" && r.transfer.status === "pending", "pickup waits for the Botlify team");
    a = await assignDriver({ transferId: r.transfer._id, driverId: own._id, scope: "platform" });
    ok(!a.ok, "the team can't assign a hotel's private driver");
    a = await assignDriver({ transferId: r.transfer._id, driverId: botlify._id, scope: "platform" });
    ok(a.ok && a.transfer.status === "confirmed", "Botlify driver assigned");

    say("A cancelled pickup can't be re-assigned.");
    await TransferBooking.updateOne({ _id: r.transfer._id }, { $set: { status: "cancelled" } });
    a = await assignDriver({ transferId: r.transfer._id, driverId: botlify._id, scope: "platform" });
    ok(!a.ok && a.reason === "closed", "refused");
  } catch (e) {
    fail++;
    console.log("  ERROR:", e.message, "\n", e.stack);
  } finally {
    await Promise.all([
      Driver.deleteMany({ $or: [{ workspaceId: { $in: [wsId, otherWs] } }, { name: { $regex: tag } }] }),
      TransferBooking.deleteMany({ workspaceId: wsId }),
      Property.deleteMany({ workspaceId: wsId }),
    ]);
    console.log("\n" + "=".repeat(52) + "\n  " + pass + " passed, " + fail + " failed\n" + "=".repeat(52));
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
