/**
 * autoDispatchService — pickups run themselves.
 *
 *   1. Paid (or no payment needed) → startDispatch(): the job is offered on
 *      WhatsApp, from Botlify's own number, to the best few eligible drivers
 *      (the hotel's own drivers for a hotel-run service, Botlify's pool
 *      otherwise).
 *   2. First driver to reply "YES T4K9" gets it (atomic claim — never two).
 *      The guest is sent the driver's name, car and number; the driver gets
 *      the guest's details; the others are told it's taken.
 *   3. Nobody answers within DISPATCH_OFFER_MINUTES → the next drivers are
 *      offered. Everyone asked and nobody took it → "exhausted": the Botlify
 *      team (or the hotel) is alerted to step in by hand.
 *   4. Reminders: driver the day before and ~90 min before.
 *   5. Driver replies "DONE T4K9" after the drop (or it auto-completes
 *      DISPATCH_AUTO_COMPLETE_HOURS after pickup) → trip completed → the
 *      driver's earning is written to the ledger → payoutService pays it.
 *
 * Manual assignment from the dashboard/admin keeps working alongside this.
 * Without WASENDER_PLATFORM_API_KEY nothing is sent and pickups simply wait
 * for manual assignment, as before.
 */
const logger = require("../../utils/logger");
const Driver = require("../../models/Driver");
const TransferBooking = require("../../models/TransferBooking");
const platformWA = require("../channels/platformWhatsApp");

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const BATCH = () => Math.max(1, num(process.env.DISPATCH_BATCH_SIZE, 3));
const OFFER_MIN = () => Math.max(2, num(process.env.DISPATCH_OFFER_MINUTES, 10));
const AUTO_COMPLETE_H = () => Math.max(1, num(process.env.DISPATCH_AUTO_COMPLETE_HOURS, 6));

const digits = (p) => String(p || "").replace(/[^\d]/g, "");
const money = (currency, amount) =>
  `${currency} ${Number(amount).toLocaleString("en-US", { maximumFractionDigits: currency === "IDR" ? 0 : 2 })}`;

function whenLabel(date, timezone) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      hour12: false, timeZone: timezone || "Asia/Makassar",
    }).format(date);
  } catch {
    return new Date(date).toISOString();
  }
}

async function context(transfer) {
  const Property = require("../../models/Property");
  const Workspace = require("../../models/Workspace");
  const [property, workspace] = await Promise.all([
    Property.findById(transfer.propertyId).lean(),
    Workspace.findById(transfer.workspaceId).select("name timezone owner").lean(),
  ]);
  return { property, workspace };
}

function route(transfer, property) {
  const airport = transfer.airportCode ? `${transfer.airportCode} airport` : "the airport";
  const hotel = [property?.name, property?.address].filter(Boolean).join(", ") || "the hotel";
  return transfer.direction === "pickup" ? { from: airport, to: hotel } : { from: hotel, to: airport };
}

/** Eligible drivers not yet offered this job, best first. */
async function nextCandidates(transfer, property, limit) {
  const offered = (transfer.dispatch?.offers || []).map((o) => String(o.driverId));
  const scope = transfer.provider === "own"
    ? { scope: "hotel", workspaceId: transfer.workspaceId }
    : { scope: "platform" };
  const areas = [transfer.airportCode, property?.city].filter(Boolean);
  const drivers = await Driver.find({
    ...scope,
    active: true,
    _id: { $nin: offered },
    "vehicle.seats": { $gte: Math.min(transfer.passengers || 1, 7) },
    $or: [{ serviceAreas: { $size: 0 } }, { serviceAreas: { $in: areas } }],
  })
    .sort({ priority: 1, "stats.lastAcceptedAt": 1 })
    .limit(limit);
  return drivers;
}

function offerText(transfer, property, workspace) {
  const r = route(transfer, property);
  const pay = transfer.provider === "platform" && transfer.driverPayout > 0
    ? `\n💰 You earn: ${money(transfer.currency, transfer.driverPayout)} (paid to your account after the trip)`
    : "";
  return (
    `🚗 New ${transfer.direction === "pickup" ? "pickup" : "drop-off"} job ${transfer.code}\n` +
    `📅 ${whenLabel(transfer.pickupAt, workspace?.timezone)}\n` +
    `📍 ${r.from} → ${r.to}\n` +
    `👥 ${transfer.passengers} passenger${transfer.passengers > 1 ? "s" : ""}` +
    (transfer.flightNumber ? ` · flight ${transfer.flightNumber}` : "") +
    pay +
    `\n\nReply *YES ${transfer.code}* to take it, or *NO ${transfer.code}* to pass.`
  );
}

/** Begin (or restart) automatic dispatch for a transfer. */
async function startDispatch(transfer) {
  if (!transfer || ["cancelled", "completed"].includes(transfer.status)) return { ok: false, reason: "closed" };
  if (transfer.dispatch?.state === "assigned") return { ok: true, already: true };
  await TransferBooking.updateOne(
    { _id: transfer._id },
    { $set: { "dispatch.state": "searching", "dispatch.nextRoundAt": new Date() } },
  );
  if (!platformWA.isConfigured()) {
    logger.info(`[dispatch] ${transfer.code}: platform WhatsApp not configured — waiting for manual assignment`);
    return { ok: true, manual: true };
  }
  return runRound(transfer._id);
}

/** Offer the job to the next batch of drivers. */
async function runRound(transferId) {
  const transfer = await TransferBooking.findById(transferId);
  if (!transfer || transfer.dispatch?.state !== "searching") return { ok: false, reason: "not_searching" };
  if (["cancelled", "completed"].includes(transfer.status)) return { ok: false, reason: "closed" };
  const { property, workspace } = await context(transfer);

  // Pickup time already gone with nobody on it — stop offering, escalate.
  if (new Date(transfer.pickupAt) < new Date()) return exhaust(transfer, property, workspace, "pickup time passed");

  const candidates = await nextCandidates(transfer, property, BATCH());
  if (!candidates.length) return exhaust(transfer, property, workspace, "no more drivers to offer");

  const text = offerText(transfer, property, workspace);
  let sent = 0;
  for (const d of candidates) {
    const r = await platformWA.send(d.phone, text);
    transfer.dispatch.offers.push({ driverId: d._id, at: new Date(), response: "none" });
    if (r.success) sent++;
    await Driver.updateOne({ _id: d._id }, { $inc: { "stats.offered": 1 }, $set: { "stats.lastOfferedAt": new Date() } });
  }
  transfer.dispatch.round = (transfer.dispatch.round || 0) + 1;
  transfer.dispatch.nextRoundAt = new Date(Date.now() + OFFER_MIN() * 60 * 1000);
  transfer.dispatch.lastError = sent ? "" : "offers could not be delivered";
  await transfer.save();
  logger.info(`[dispatch] ${transfer.code}: round ${transfer.dispatch.round} offered to ${candidates.length} (${sent} delivered)`);
  return { ok: true, offered: candidates.length, delivered: sent };
}

async function exhaust(transfer, property, workspace, why) {
  await TransferBooking.updateOne(
    { _id: transfer._id, "dispatch.state": "searching" },
    { $set: { "dispatch.state": "exhausted", "dispatch.nextRoundAt": null, "dispatch.lastError": why } },
  );
  logger.warn(`[dispatch] ${transfer.code}: exhausted (${why})`);
  const label = whenLabel(transfer.pickupAt, workspace?.timezone);
  if (transfer.provider === "platform") {
    const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL;
    if (to) {
      const { sendEmail } = require("../emailService");
      await sendEmail({
        to,
        subject: `⚠️ No driver took ${transfer.code} — ${property?.name || "hotel"} ${label}`,
        html: `<p>No Botlify driver accepted job <b>${transfer.code}</b> (${why}).</p><p>Guest: ${transfer.guestName || "—"} ${transfer.guestPhone || ""}<br>When: ${label}<br>Passengers: ${transfer.passengers}</p><p>Assign someone by hand in Admin → Pickups.</p>`,
      }).catch(() => {});
    }
  }
  const { notify } = require("../notificationService");
  notify(transfer.workspaceId, {
    type: "transfer.needs_driver",
    title: `No driver yet · ${transfer.guestName || "Guest"} ${label}`,
    body: transfer.provider === "platform"
      ? "None of our drivers has accepted yet — the Botlify team is arranging one by hand."
      : "None of your drivers accepted. Assign one in Transfers.",
    link: "/dashboard/transfers",
    priority: "high",
    dedupeKey: `transfer:needs:${transfer._id}`,
  });
  return { ok: false, reason: "exhausted" };
}

// ── Driver replies on WhatsApp ──────────────────────────────────────────────

const CMD = [
  { re: /^(yes|y|ya|iya|ok|oke|accept|terima|ambil)\b/i, action: "accept" },
  { re: /^(no|n|tidak|nggak|gak|skip|pass|tolak)\b/i, action: "decline" },
  { re: /^(done|selesai|finish|finished|completed?)\b/i, action: "done" },
  { re: /^(here|arrived|sampai|sudah sampai|tiba)\b/i, action: "arrived" },
];

function parseCommand(text) {
  const t = String(text || "").trim();
  const hit = CMD.find((c) => c.re.test(t));
  if (!hit) return null;
  const code = (t.match(/\bT[A-Z0-9]{4}\b/i) || [])[0];
  return { action: hit.action, code: code ? code.toUpperCase() : null };
}

async function findDriverByPhone(phone) {
  const d = digits(phone);
  if (!d) return [];
  let drivers = await Driver.find({ phoneDigits: d, active: true });
  if (!drivers.length) {
    // Records saved before phoneDigits existed: compare in memory.
    const all = await Driver.find({ active: true }).select("+phone");
    drivers = all.filter((x) => digits(x.phone) === d || digits(x.phone).replace(/^0/, "62") === d);
  }
  return drivers;
}

/** Handle one inbound WhatsApp message on Botlify's platform number. */
async function handleDriverMessage({ from, text }) {
  const drivers = await findDriverByPhone(from);
  if (!drivers.length) return { ok: false, reason: "unknown_sender" };
  const cmd = parseCommand(text);
  if (!cmd) {
    await platformWA.send(from, "Reply YES <code> to take a job, NO <code> to pass, HERE <code> when you're at the pickup point, and DONE <code> after the drop-off. 🙏");
    return { ok: true, help: true };
  }
  const ids = drivers.map((d) => d._id);

  if (cmd.action === "accept" || cmd.action === "decline") {
    const filter = { "dispatch.offers.driverId": { $in: ids }, status: { $nin: ["cancelled", "completed"] } };
    if (cmd.code) filter.code = cmd.code;
    else filter["dispatch.state"] = "searching";
    const open = await TransferBooking.find(filter).sort({ pickupAt: 1 }).limit(2);
    if (!open.length) {
      await platformWA.send(from, cmd.code ? `I couldn't find job ${cmd.code} for you.` : "You have no open job offers right now.");
      return { ok: false, reason: "no_offer" };
    }
    if (!cmd.code && open.length > 1) {
      await platformWA.send(from, `You have more than one offer — please reply with the code, e.g. YES ${open[0].code}.`);
      return { ok: false, reason: "ambiguous" };
    }
    const transfer = open[0];
    const offer = transfer.dispatch.offers.find((o) => ids.some((i) => String(i) === String(o.driverId)));
    const driver = drivers.find((d) => String(d._id) === String(offer.driverId));
    return cmd.action === "accept" ? accept(transfer, driver, from) : decline(transfer, driver, from);
  }

  // done / arrived: a job assigned to this driver
  const filter = { driverId: { $in: ids }, status: { $in: ["confirmed", "pending"] } };
  if (cmd.code) filter.code = cmd.code;
  const jobs = await TransferBooking.find(filter).sort({ pickupAt: 1 }).limit(2);
  if (!jobs.length) {
    await platformWA.send(from, cmd.code ? `Job ${cmd.code} isn't assigned to you.` : "You have no active job.");
    return { ok: false, reason: "no_job" };
  }
  if (!cmd.code && jobs.length > 1) {
    await platformWA.send(from, `You have more than one job — please add the code, e.g. ${cmd.action.toUpperCase()} ${jobs[0].code}.`);
    return { ok: false, reason: "ambiguous" };
  }
  const job = jobs[0];
  if (cmd.action === "arrived") {
    const { messageGuest } = require("../messaging/guestMessenger");
    const name = job.driverSnapshot?.name || "Your driver";
    if (job.conversationId) {
      await messageGuest(
        job.conversationId,
        `${name} is here and waiting for you 🚗${job.driverSnapshot?.vehicleLabel ? ` (${job.driverSnapshot.vehicleLabel})` : ""}. WhatsApp: ${job.driverSnapshot?.phone || ""}`,
      ).catch(() => {});
    }
    await platformWA.send(from, "Thanks — the guest has been told you're there. 👍");
    return { ok: true, arrived: true };
  }
  const res = await completeTransfer(job, "driver");
  await platformWA.send(
    from,
    res.earning
      ? `Thanks! ${job.code} completed ✅ ${money(job.currency, job.driverPayout)} has been added to your next payout.`
      : `Thanks! ${job.code} completed ✅`,
  );
  return { ok: true, completed: true };
}

async function accept(transfer, driver, from) {
  // Atomic claim: only one driver can flip searching → assigned.
  const claimed = await TransferBooking.findOneAndUpdate(
    { _id: transfer._id, "dispatch.state": { $in: ["searching", "exhausted"] }, driverId: null },
    { $set: { "dispatch.state": "assigned", driverId: driver._id, "dispatch.nextRoundAt": null, "dispatch.offers.$[o].response": "accepted" } },
    { new: true, arrayFilters: [{ "o.driverId": driver._id }] },
  );
  if (!claimed) {
    await TransferBooking.updateOne(
      { _id: transfer._id },
      { $set: { "dispatch.offers.$[o].response": "late" } },
      { arrayFilters: [{ "o.driverId": driver._id }] },
    );
    await platformWA.send(from, `Sorry, ${transfer.code} was just taken by another driver. 🙏`);
    return { ok: false, reason: "taken" };
  }

  // Snapshot + guest hand-off via the existing assignment path.
  const { assignDriver } = require("./dispatchService");
  const scope = claimed.provider === "own" ? "hotel" : "platform";
  const res = await assignDriver({ transferId: claimed._id, driverId: driver._id, scope, workspaceId: claimed.workspaceId });

  const { property, workspace } = await context(claimed);
  const r = route(claimed, property);
  await platformWA.send(
    from,
    `✅ ${claimed.code} is yours!\n📅 ${whenLabel(claimed.pickupAt, workspace?.timezone)}\n📍 ${r.from} → ${r.to}\n` +
      `👤 ${claimed.guestName || "Guest"}${claimed.guestPhone ? ` · +${digits(claimed.guestPhone)}` : ""}\n` +
      (claimed.flightNumber ? `✈️ Flight ${claimed.flightNumber}\n` : "") +
      `\nReply HERE ${claimed.code} when you're at the pickup point and DONE ${claimed.code} after the drop-off.`,
  );

  // Tell the others it's gone (only those who haven't answered).
  for (const o of claimed.dispatch.offers) {
    if (String(o.driverId) === String(driver._id) || o.response !== "none") continue;
    const other = await Driver.findById(o.driverId).select("phone");
    if (other) await platformWA.send(other.phone, `${claimed.code} has been taken — thanks! 🙏`);
  }

  const { notify } = require("../notificationService");
  notify(claimed.workspaceId, {
    type: "transfer.driver_assigned",
    title: `Driver assigned · ${claimed.guestName || "Guest"}`,
    body: `${driver.displayName} accepted ${claimed.code} (${whenLabel(claimed.pickupAt, workspace?.timezone)}).`,
    link: "/dashboard/transfers",
    priority: "normal",
    dedupeKey: `transfer:needs:${claimed._id}`,
  });
  logger.info(`[dispatch] ${claimed.code}: accepted by driver ${driver._id}`);
  return { ok: true, assigned: true, guestTold: !!res?.guestTold };
}

async function decline(transfer, driver, from) {
  await TransferBooking.updateOne(
    { _id: transfer._id },
    { $set: { "dispatch.offers.$[o].response": "declined" } },
    { arrayFilters: [{ "o.driverId": driver._id }] },
  );
  await Driver.updateOne({ _id: driver._id }, { $inc: { "stats.declined": 1 } });
  await platformWA.send(from, `No problem — ${transfer.code} passed on. 👍`);
  // Everyone in this round said no → don't wait out the timer.
  const fresh = await TransferBooking.findById(transfer._id);
  if (fresh?.dispatch?.state === "searching" && !fresh.dispatch.offers.some((o) => o.response === "none")) {
    await runRound(fresh._id);
  }
  return { ok: true, declined: true };
}

/** Close a trip and (for paid Botlify trips) write the driver's earning. */
async function completeTransfer(transfer, by = "auto") {
  const done = await TransferBooking.findOneAndUpdate(
    { _id: transfer._id, status: { $in: ["confirmed", "pending"] } },
    { $set: { status: "completed", completedAt: new Date(), completedBy: by } },
    { new: true },
  );
  if (!done) return { ok: false, reason: "not_open" };
  if (done.driverId) await Driver.updateOne({ _id: done.driverId }, { $inc: { "stats.completed": 1 } });

  // A Botlify driver is paid by us only when the guest paid Botlify online;
  // a cash trip is settled between guest and driver.
  let earning = null;
  if (done.provider === "platform" && done.driverId && done.paymentStatus === "paid" && done.driverPayout > 0) {
    const { recordDriverEarning } = require("../commissionService");
    earning = await recordDriverEarning({ transfer: done, driverId: done.driverId, amount: done.driverPayout, currency: done.currency });
    if (earning) await TransferBooking.updateOne({ _id: done._id }, { $set: { driverEarningEntryId: earning._id } });
  }
  logger.info(`[dispatch] ${done.code}: completed by ${by}${earning ? " (earning recorded)" : ""}`);
  return { ok: true, earning: !!earning };
}

// ── Minute tick: rounds, reminders, auto-complete ───────────────────────────

async function tick(now = new Date()) {
  const stats = { rounds: 0, reminders: 0, completed: 0 };

  if (platformWA.isConfigured()) {
    const due = await TransferBooking.find({ "dispatch.state": "searching", "dispatch.nextRoundAt": { $lte: now }, status: { $nin: ["cancelled", "completed"] } }).select("_id").limit(50);
    for (const t of due) {
      await runRound(t._id).catch((e) => logger.warn(`[dispatch] round failed: ${e.message}`));
      stats.rounds++;
    }

    const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
    const in90m = new Date(now.getTime() + 90 * 60 * 1000);
    const upcoming = await TransferBooking.find({
      "dispatch.state": "assigned", status: "confirmed", pickupAt: { $gt: now, $lte: in24h },
      $or: [{ "reminders.driverDayBefore": null }, { "reminders.driverSoon": null }],
    }).limit(100);
    for (const t of upcoming) {
      const soon = t.pickupAt <= in90m;
      const field = soon ? "reminders.driverSoon" : "reminders.driverDayBefore";
      if (soon ? t.reminders?.driverSoon : t.reminders?.driverDayBefore) continue;
      const claimed = await TransferBooking.updateOne({ _id: t._id, [field]: null }, { $set: { [field]: now } });
      if (!claimed.modifiedCount) continue;
      if (soon) await TransferBooking.updateOne({ _id: t._id, "reminders.driverDayBefore": null }, { $set: { "reminders.driverDayBefore": now } });
      const driver = await Driver.findById(t.driverId).select("phone");
      if (!driver) continue;
      const { property, workspace } = await context(t);
      const r = route(t, property);
      await platformWA.send(
        driver.phone,
        `⏰ Reminder: ${t.code} ${soon ? "is coming up" : "is tomorrow"} — ${whenLabel(t.pickupAt, workspace?.timezone)}\n📍 ${r.from} → ${r.to}\n👤 ${t.guestName || "Guest"}${t.flightNumber ? ` · flight ${t.flightNumber}` : ""}`,
      );
      stats.reminders++;
    }
  }

  // Auto-complete trips well past their pickup time (driver forgot DONE).
  const cutoff = new Date(now.getTime() - AUTO_COMPLETE_H() * 3600 * 1000);
  const stale = await TransferBooking.find({ status: "confirmed", "dispatch.state": "assigned", pickupAt: { $lte: cutoff } }).limit(100);
  for (const t of stale) {
    const r = await completeTransfer(t, "auto");
    if (r.ok) stats.completed++;
  }
  return stats;
}

module.exports = { startDispatch, runRound, handleDriverMessage, completeTransfer, tick, parseCommand };
