/**
 * Payments + pickups + payouts — end-to-end, no humans.
 *
 *  1. AI books a stay → payment link on the hotel's Xendit sub-account with
 *     Botlify's 10% split → paid webhook → booking paid, commission collected.
 *  2. Consultant share on that commission becomes payable automatically.
 *  3. AI books a pickup → Botlify fare → payment link to Botlify → paid →
 *     drivers offered the job on WhatsApp → first YES wins, second is told
 *     it's taken → DONE → driver earning in the ledger.
 *  4. Driver + consultant payouts go out through Xendit; payout webhook marks
 *     them paid; a failed payout releases the money for the next run.
 *  5. Hotel not verified yet → no link, booking still works (pay at property).
 *  6. Unpaid pickup link expires → pickup released.
 *  7. Nobody accepts → next round, then "exhausted".
 * Only Xendit's and WhatsApp's HTTP calls are stubbed.
 * Run: node scripts/testPaymentsAutomation.js
 */
require("dotenv").config();
process.env.XENDIT_SECRET_KEY = "xnd_test_key";
process.env.XENDIT_WEBHOOK_TOKEN = "cb-token-123";
process.env.WASENDER_PLATFORM_API_KEY = "platform-key-0123456789";
process.env.WASENDER_PLATFORM_WEBHOOK_SECRET = "plat-secret";
process.env.PLATFORM_TRANSFER_PRICES = '{"DPS":300000}';
process.env.DRIVER_PAYOUT_RATE = "0.75";
process.env.CONSULTANT_PAYOUT_HOLD_DAYS = "0";
process.env.DRIVER_PAYOUT_HOLD_HOURS = "0";
process.env.PAYOUT_MIN_IDR = "10000";
process.env.PAYOUTS_AUTO = "true";

const mongoose = require("mongoose");
let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log("  PASS  " + l); } else { fail++; console.log("  FAIL  " + l + (x !== undefined ? `  (${JSON.stringify(x)})` : "")); } };
const resMock = () => { const r = { code: 200, headersSent: false }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; r.headersSent = true; return r; }; r.sendStatus = (c) => { r.code = c; r.headersSent = true; return r; }; return r; };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  // ── Stubs ────────────────────────────────────────────────────────────────
  const xen = require("../src/services/payments/xenPlatformService");
  const invoices = []; const rules = []; const payouts = [];
  let payoutShouldFail = false;
  xen.splitRuleFor = async (pct) => { rules.push(pct); return `splitru_${pct}`; };
  xen.createInvoice = async (p) => { invoices.push(p); return { invoiceId: `inv_${invoices.length}`, url: `https://checkout.xendit.co/inv_${invoices.length}`, status: "PENDING", expiresAt: null }; };
  xen.createPayout = async (p) => { if (payoutShouldFail) throw Object.assign(new Error("INVALID_DESTINATION"), { response: { data: { message: "INVALID_DESTINATION" } } }); payouts.push(p); return { payoutId: `disb_${payouts.length}`, status: "ACCEPTED" }; };
  const wa = require("../src/services/channels/platformWhatsApp");
  const waSent = [];
  wa.send = async (phone, text) => { waSent.push({ phone: String(phone).replace(/[^\d]/g, ""), text }); return { success: true }; };

  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const TransferBooking = require("../src/models/TransferBooking");
  const CommissionEntry = require("../src/models/CommissionEntry");
  const Consultant = require("../src/models/Consultant");
  const Driver = require("../src/models/Driver");
  const Payment = require("../src/models/Payment");
  const Payout = require("../src/models/Payout");
  const Notification = require("../src/models/Notification");
  const ctrl = require("../src/controllers/paymentsController");
  const { createBooking } = require("../src/services/hotel/bookingService");
  const { createTransfer } = require("../src/services/transfers/transferService");
  const dispatch = require("../src/services/transfers/autoDispatchService");
  const { runPayouts } = require("../src/services/payments/payoutService");

  const hook = async (body) => { const r = resMock(); await ctrl.webhook({ headers: { "x-callback-token": "cb-token-123" }, body }, r); await new Promise((s) => setTimeout(s, 300)); return r; };
  const tag = String(Date.now()).slice(-6);
  const made = { ws: [], drivers: [], consultants: [] };
  const day = (n) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  try {
    const consultant = await Consultant.create({ userId: new mongoose.Types.ObjectId(), fullName: "Made Consultant", phone: "+6281100" + tag, status: "approved", payout: { channelCode: "ID_BCA", accountNumber: "1234567890", accountName: "Made Consultant", currency: "IDR" } });
    made.consultants.push(consultant._id);
    const ws = await Workspace.create({
      name: "Pay Test Villa " + tag, owner: new mongoose.Types.ObjectId(), industry: "hospitality",
      subscription: { plan: "hotel_pro", status: "active" },
      payments: { provider: "xendit", accountId: "acct_hotel_1", accountStatus: "LIVE", collectOnline: true, depositPercent: 100 },
      acquisition: { consultantId: consultant._id, consultantCode: consultant.code, attributedAt: new Date() },
    });
    made.ws.push(ws._id);
    const property = await Property.create({ workspaceId: ws._id, name: "Pay Test Villa", address: "Jl. Pantai 1", city: "Canggu", currency: "IDR", transfers: { hasOwnService: false, offerPartnerService: true, airportCode: "DPS" } });
    const room = await RoomType.create({ workspaceId: ws._id, propertyId: property._id, name: "Garden Villa", unitsCount: 3, baseRate: 1000000, currency: "IDR" });

    console.log("\n1. AI books a stay → payment link with Botlify's split");
    const b = await createBooking({ workspace: ws, roomTypeId: room._id, checkIn: day(10), checkOut: day(12), guestName: "Sofia", guestPhone: "+628120000" + tag, source: "whatsapp" });
    ok(b.ok && b.booking.totalAmount === 2000000, "booking created (2 nights × 1,000,000)", b.reason);
    ok(b.payment?.url && b.confirmationText.includes(b.payment.url), "guest confirmation carries the payment link");
    const inv1 = invoices[0];
    ok(inv1?.forUserId === "acct_hotel_1" && inv1.splitRuleId === "splitru_10", "invoice made FOR the hotel's sub-account WITH a 10% split", inv1 && { f: inv1.forUserId, s: inv1.splitRuleId });
    ok(inv1?.amount === 2000000 && inv1.currency === "IDR", "full amount in IDR");
    const pay1 = await Payment.findById(b.payment._id).lean();
    ok(pay1.platformFee === 200000 && pay1.netToReceiver === 1800000, "Botlify 200,000 / hotel 1,800,000", { fee: pay1.platformFee, net: pay1.netToReceiver });

    let r = resMock();
    await ctrl.webhook({ headers: { "x-callback-token": "wrong" }, body: { external_id: String(pay1._id), status: "PAID" } }, r);
    ok(r.code === 401, "forged Xendit callback rejected");
    await hook({ id: "inv_1", external_id: String(pay1._id), status: "PAID", paid_amount: 2000000, payment_channel: "QRIS" });
    const bk = await HotelBooking.findById(b.booking._id).lean();
    ok(bk.payment.status === "paid" && bk.payment.method === "QRIS", "booking marked paid (QRIS)", bk.payment);
    const commission = await CommissionEntry.findById(bk.commission.ledgerEntryId).lean();
    ok(commission.status === "paid" && commission.collectedAt, "commission collected at source — never invoiced", commission.status);
    await hook({ id: "inv_1", external_id: String(pay1._id), status: "SETTLED" });
    ok((await Payment.countDocuments({ _id: pay1._id, status: "paid" })) === 1, "SETTLED after PAID handled once");
    ok(await Notification.exists({ workspaceId: ws._id, type: "payment.received" }), "hotel notified of the payment");

    console.log("\n2. Consultant share becomes payable automatically");
    const share = await CommissionEntry.findOne({ parentEntryId: commission._id, kind: "consultant_share" }).lean();
    ok(share && share.amount === 40000, "20% share accrued (40,000)", share?.amount);

    console.log("\n3. Pickup: Botlify fare → paid → WhatsApp dispatch → DONE");
    const d1 = await Driver.create({ scope: "platform", name: "Wayan Satu", phone: "+62 811 1" + tag, payout: { channelCode: "ID_GOPAY", accountNumber: "0811" + tag, accountHolderName: "Wayan Satu" }, priority: 1 });
    const d2 = await Driver.create({ scope: "platform", name: "Ketut Dua", phone: "+62 811 2" + tag, payout: { channelCode: "ID_BCA", accountNumber: "99" + tag, accountHolderName: "Ketut Dua" }, priority: 2 });
    made.drivers.push(d1._id, d2._id);
    const pickupAt = new Date(Date.now() + 2 * 86400000);
    const t = await createTransfer({ workspace: ws, transfer: { direction: "pickup", pickupAt: pickupAt.toISOString(), flightNumber: "QZ 512", guestName: "Sofia", guestPhone: "+628120000" + tag, passengers: 2 }, property });
    ok(t.ok && t.transfer.provider === "platform" && t.transfer.price === 300000 && t.transfer.driverPayout === 225000, "Botlify fare 300,000, driver gets 225,000", t.transfer && { p: t.transfer.price, d: t.transfer.driverPayout });
    const inv2 = invoices[1];
    ok(inv2 && !inv2.forUserId && !inv2.splitRuleId, "Botlify's own service is invoiced on the master account");
    ok(t.confirmationText.includes(t.payment.url) && t.transfer.dispatch.state === "awaiting_payment", "guest gets the link; no driver offered before payment");
    ok(waSent.length === 0, "no WhatsApp offers yet");

    await hook({ id: "inv_2", external_id: String(t.payment._id), status: "PAID", payment_channel: "BCA" });
    let tr = await TransferBooking.findById(t.transfer._id).lean();
    ok(tr.paymentStatus === "paid" && tr.dispatch.state === "searching", "paid → dispatch started", { p: tr.paymentStatus, s: tr.dispatch.state });
    ok(tr.dispatch.offers.length === 2 && waSent.filter((m) => m.text.includes(tr.code)).length === 2, "both drivers offered the job on WhatsApp", tr.dispatch.offers.length);
    ok(waSent[0].text.includes("225,000"), "offer shows what the driver earns");
    const margin = await CommissionEntry.findOne({ transferId: tr._id, kind: "platform_revenue" }).lean();
    ok(margin?.amount === 75000 && margin.collectedAt, "Botlify margin 75,000 collected", margin?.amount);

    waSent.length = 0;
    let h = await dispatch.handleDriverMessage({ from: d2.phone, text: `yes ${tr.code.toLowerCase()}` });
    ok(h.assigned, "driver 2 says YES → assigned", h);
    h = await dispatch.handleDriverMessage({ from: d1.phone, text: `YES ${tr.code}` });
    ok(h.reason === "taken", "driver 1 too late → told it's taken");
    tr = await TransferBooking.findById(t.transfer._id).lean();
    ok(String(tr.driverId) === String(d2._id) && tr.driverSnapshot.name === "Ketut" && tr.status === "confirmed", "one driver, snapshot saved, confirmed");
    ok(waSent.some((m) => m.phone === d2.phoneDigits && m.text.includes("is yours")), "winner gets the guest's details");

    h = await dispatch.handleDriverMessage({ from: d2.phone, text: "done" });
    tr = await TransferBooking.findById(t.transfer._id).lean();
    ok(h.completed && tr.status === "completed" && tr.completedBy === "driver", "DONE closes the trip");
    const earning = await CommissionEntry.findOne({ transferId: tr._id, kind: "driver_earning" }).lean();
    ok(earning?.amount === 225000 && String(earning.driverId) === String(d2._id), "driver earning 225,000 in the ledger");
    await dispatch.completeTransfer(tr, "auto");
    ok((await CommissionEntry.countDocuments({ transferId: tr._id, kind: "driver_earning" })) === 1, "never paid twice");

    console.log("\n4. Automatic payouts");
    payoutShouldFail = true;
    let s = await runPayouts("driver");
    const failedPo = await Payout.findOne({ recipientId: d2._id }).lean();
    ok(s.failed === 1 && failedPo?.status === "failed", "failed payout recorded");
    ok((await CommissionEntry.findById(earning._id).lean()).status === "verified", "money released for the next run");
    payoutShouldFail = false;
    s = await runPayouts("driver");
    const dp = payouts.find((p) => p.accountNumber === "99" + tag);
    ok(dp && dp.amount === 225000 && dp.channelCode === "ID_BCA", "driver paid 225,000 to BCA", dp);
    const po = await Payout.findOne({ recipientId: d2._id, status: "processing" }).lean();
    await hook({ event: "payout.succeeded", data: { id: "disb_x", reference_id: po.referenceId, status: "SUCCEEDED" } });
    ok((await CommissionEntry.findById(earning._id).lean()).status === "paid", "payout webhook → earning paid");
    ok((await Driver.findById(d2._id).lean()).earnings.paid === 225000, "driver lifetime paid updated");
    ok(waSent.some((m) => m.phone === d2.phoneDigits && m.text.includes("paid you")), "driver gets a WhatsApp receipt");

    s = await runPayouts("consultant");
    const cp = payouts.find((p) => p.accountNumber === "1234567890");
    // 40,000 from the stay commission + 20% of the 75,000 pickup margin = 55,000
    ok(cp && cp.amount === 55000, "consultant paid 55,000 (stay + pickup shares)", cp?.amount);

    console.log("\n5. Hotel not verified yet → pay at property");
    await Workspace.updateOne({ _id: ws._id }, { $set: { "payments.accountStatus": "AWAITING_DOCS" } });
    const ws2 = await Workspace.findById(ws._id);
    const before = invoices.length;
    const b2 = await createBooking({ workspace: ws2, roomTypeId: room._id, checkIn: day(20), checkOut: day(21), guestName: "Ana", source: "instagram" });
    ok(b2.ok && !b2.payment && invoices.length === before && !/xendit/.test(b2.confirmationText), "booking works, no link sent");

    console.log("\n6. Unpaid pickup link expires");
    const t2 = await createTransfer({ workspace: ws2, transfer: { direction: "dropoff", pickupAt: new Date(Date.now() + 3 * 86400000).toISOString(), guestName: "Ana" }, property });
    ok(t2.payment, "platform pickups still take payment (Botlify's own account)");
    await hook({ id: "inv_x", external_id: String(t2.payment._id), status: "EXPIRED" });
    ok((await TransferBooking.findById(t2.transfer._id).lean()).status === "cancelled", "expired → pickup released");

    console.log("\n7. Nobody accepts → next round → exhausted");
    const t3 = await TransferBooking.create({ workspaceId: ws._id, propertyId: property._id, direction: "pickup", pickupAt: new Date(Date.now() + 86400000), provider: "platform", price: 300000, currency: "IDR", status: "pending", passengers: 2, airportCode: "DPS", paymentStatus: "paid" });
    await dispatch.startDispatch(t3);
    let t3d = await TransferBooking.findById(t3._id).lean();
    ok(t3d.dispatch.offers.length >= 2, "first round offered");
    await TransferBooking.updateOne({ _id: t3._id }, { $set: { "dispatch.nextRoundAt": new Date(Date.now() - 1000) } });
    // Only our two test drivers exist in this test's view if the pool is empty otherwise;
    // keep offering until exhausted.
    for (let i = 0; i < 20; i++) {
      t3d = await TransferBooking.findById(t3._id).lean();
      if (t3d.dispatch.state !== "searching") break;
      await TransferBooking.updateOne({ _id: t3._id }, { $set: { "dispatch.nextRoundAt": new Date(Date.now() - 1000) } });
      await dispatch.tick();
    }
    ok(t3d.dispatch.state === "exhausted", "everyone asked, nobody took it → exhausted", t3d.dispatch.state);
    ok(await Notification.exists({ workspaceId: ws._id, type: "transfer.needs_driver" }), "hotel told a person is stepping in");

    console.log("\n8. Command parsing");
    ok(dispatch.parseCommand("Ya T4K9")?.action === "accept" && dispatch.parseCommand("selesai").action === "done", "Indonesian replies understood");
    ok(xen.parseCallback({ event: "payout.failed", data: { reference_id: "x", status: "FAILED" } }).type === "payout", "payout callback parsed");
  } catch (err) { fail++; console.log("  ERROR:", err.message, err.stack); }
  finally {
    const wsIds = made.ws;
    await Promise.all([
      Payment.deleteMany({ workspaceId: { $in: wsIds } }),
      HotelBooking.deleteMany({ workspaceId: { $in: wsIds } }),
      TransferBooking.deleteMany({ workspaceId: { $in: wsIds } }),
      CommissionEntry.deleteMany({ $or: [{ workspaceId: { $in: wsIds } }, { driverId: { $in: made.drivers } }] }),
      Payout.deleteMany({ recipientId: { $in: [...made.drivers, ...made.consultants] } }),
      Notification.deleteMany({ workspaceId: { $in: wsIds } }),
      Property.deleteMany({ workspaceId: { $in: wsIds } }),
      RoomType.deleteMany({ workspaceId: { $in: wsIds } }),
      Driver.deleteMany({ _id: { $in: made.drivers } }),
      Consultant.deleteMany({ _id: { $in: made.consultants } }),
      Workspace.deleteMany({ _id: { $in: wsIds } }),
    ]).catch(() => {});
    console.log(`\n  ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
