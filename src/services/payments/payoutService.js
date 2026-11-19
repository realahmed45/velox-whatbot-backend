/**
 * payoutService — drivers and consultants get paid without anyone touching it.
 *
 *  1. autoVerify(): a ledger entry becomes payable ("verified") once
 *       - consultant_share: Botlify actually received the revenue it derives
 *         from (parent.collectedAt) AND CONSULTANT_PAYOUT_HOLD_DAYS (14) have
 *         passed — the refund/chargeback window;
 *       - driver_earning: the trip is completed and DRIVER_PAYOUT_HOLD_HOURS
 *         (24) have passed.
 *  2. runPayouts(type): bundles each person's verified entries into ONE Xendit
 *     payout to their bank / e-wallet (minimum PAYOUT_MIN_IDR, default 50,000).
 *     USD consultant shares are converted at FX_USD_IDR.
 *  3. handlePayoutEvent(): Xendit confirms → entries "paid", totals updated,
 *     the person gets a WhatsApp receipt. A failure releases the entries to
 *     the next run and alerts the Botlify team.
 *
 * Schedule (server.js): drivers daily, consultants monthly. Set
 * PAYOUTS_AUTO=false to pause everything (entries keep accruing).
 *
 * Funding: payouts come from Botlify's Xendit master balance, which is filled
 * by the split fees and Botlify-driver fares. Consultant shares on SaaS revenue
 * (collected by Creem, not Xendit) need that balance topped up — the admin
 * payouts screen shows the balance needed before each run.
 */
const logger = require("../../utils/logger");
const CommissionEntry = require("../../models/CommissionEntry");
const Payout = require("../../models/Payout");
const xen = require("./xenPlatformService");

const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const enabled = () => process.env.PAYOUTS_AUTO !== "false" && xen.isConfigured();

/** Convert a ledger amount to the payout currency. null = no rate known. */
function convert(amount, from, to) {
  from = String(from || "USD").toUpperCase();
  to = String(to || "IDR").toUpperCase();
  if (from === to) return { amount, rate: 1 };
  const usdIdr = num(process.env.FX_USD_IDR, null);
  if (!usdIdr) return null;
  if (from === "USD" && to === "IDR") return { amount: Math.round(amount * usdIdr), rate: usdIdr };
  if (from === "IDR" && to === "USD") return { amount: Math.round((amount / usdIdr) * 100) / 100, rate: 1 / usdIdr };
  return null;
}

async function autoVerify(now = new Date()) {
  const holdDays = num(process.env.CONSULTANT_PAYOUT_HOLD_DAYS, 14);
  const holdHours = num(process.env.DRIVER_PAYOUT_HOLD_HOURS, 24);
  let consultants = 0;
  let drivers = 0;

  // Consultant shares whose parent revenue was collected long enough ago.
  const collectedBefore = new Date(now.getTime() - holdDays * 86400000);
  const shares = await CommissionEntry.find({ kind: "consultant_share", status: "accrued" })
    .populate("parentEntryId", "collectedAt status")
    .limit(2000);
  for (const s of shares) {
    const parent = s.parentEntryId;
    if (!parent || parent.status === "void" || !parent.collectedAt) continue;
    if (parent.collectedAt > collectedBefore) continue;
    await CommissionEntry.updateOne(
      { _id: s._id, status: "accrued" },
      { $set: { status: "verified", verifiedAt: now, verifiedBy: "auto" } },
    );
    consultants++;
  }

  // Driver earnings past the hold period.
  const earnedBefore = new Date(now.getTime() - holdHours * 3600000);
  const r = await CommissionEntry.updateMany(
    { kind: "driver_earning", status: "accrued", createdAt: { $lte: earnedBefore } },
    { $set: { status: "verified", verifiedAt: now, verifiedBy: "auto" } },
  );
  drivers = r.modifiedCount || 0;
  return { consultants, drivers };
}

/** Who gets paid and where. */
async function recipientFor(type, id) {
  if (type === "driver") {
    const Driver = require("../../models/Driver");
    const d = await Driver.findById(id).lean();
    if (!d) return null;
    return {
      name: d.name,
      phone: d.phone,
      currency: d.earnings?.currency || "IDR",
      channelCode: d.payout?.channelCode,
      accountNumber: d.payout?.accountNumber,
      accountHolderName: d.payout?.accountHolderName || d.name,
    };
  }
  const Consultant = require("../../models/Consultant");
  const c = await Consultant.findById(id).lean();
  if (!c || c.status === "suspended") return null;
  return {
    name: c.fullName,
    phone: c.phone,
    currency: c.payout?.currency || "IDR",
    channelCode: c.payout?.channelCode,
    accountNumber: c.payout?.accountNumber,
    accountHolderName: c.payout?.accountName || c.fullName,
  };
}

/**
 * Pay everyone of one type their verified balance.
 * @param {"driver"|"consultant"} type
 */
async function runPayouts(type, { dryRun = false } = {}) {
  const summary = { type, paid: 0, skipped: [], failed: 0, total: {} };
  if (!enabled() && !dryRun) {
    summary.skipped.push({ reason: "payouts disabled or Xendit not configured" });
    return summary;
  }
  await autoVerify();

  const kind = type === "driver" ? "driver_earning" : "consultant_share";
  const field = type === "driver" ? "$driverId" : "$consultantId";
  const groups = await CommissionEntry.aggregate([
    { $match: { kind, status: "verified" } },
    { $group: { _id: { who: field, currency: "$currency" }, total: { $sum: "$amount" }, ids: { $push: "$_id" } } },
  ]);

  // One payout per person: merge currencies after converting.
  const byPerson = new Map();
  for (const g of groups) {
    if (!g._id.who) continue;
    const key = String(g._id.who);
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(g);
  }

  const minIdr = num(process.env.PAYOUT_MIN_IDR, 50000);
  for (const [who, lines] of byPerson) {
    const r = await recipientFor(type, who);
    if (!r) {
      summary.skipped.push({ who, reason: "recipient missing or suspended" });
      continue;
    }
    if (!r.channelCode || !r.accountNumber || !r.accountHolderName) {
      summary.skipped.push({ who, name: r.name, reason: "no payout account set" });
      continue;
    }
    let amount = 0;
    let fxRate = 1;
    let sourceAmount = 0;
    let sourceCurrency = null;
    const ids = [];
    let convertible = true;
    for (const l of lines) {
      const c = convert(l.total, l._id.currency, r.currency);
      if (!c) {
        convertible = false;
        break;
      }
      amount += c.amount;
      if (l._id.currency !== r.currency) {
        fxRate = c.rate;
        sourceAmount += l.total;
        sourceCurrency = l._id.currency;
      }
      ids.push(...l.ids);
    }
    if (!convertible) {
      summary.skipped.push({ who, name: r.name, reason: "set FX_USD_IDR to convert currencies" });
      continue;
    }
    amount = xen.roundFor(amount, r.currency);
    const minimum = r.currency === "IDR" ? minIdr : convert(minIdr, "IDR", r.currency)?.amount || 0;
    if (amount < minimum) {
      summary.skipped.push({ who, name: r.name, reason: `below minimum (${r.currency} ${amount})` });
      continue;
    }
    summary.total[r.currency] = (summary.total[r.currency] || 0) + amount;
    if (dryRun) {
      summary.paid++;
      continue;
    }

    const referenceId = `bl-${type}-${who}-${Date.now()}`;
    const payout = await Payout.create({
      recipientType: type,
      recipientId: who,
      recipientName: r.name,
      amount,
      currency: r.currency,
      sourceAmount: sourceCurrency ? Math.round(sourceAmount * 100) / 100 : undefined,
      sourceCurrency: sourceCurrency || undefined,
      fxRate: sourceCurrency ? fxRate : undefined,
      channelCode: r.channelCode,
      accountNumber: r.accountNumber,
      accountHolderName: r.accountHolderName,
      entryIds: ids,
      referenceId,
      sentAt: new Date(),
    });
    // Lock the entries into this payout first so a parallel run can't take them.
    await CommissionEntry.updateMany(
      { _id: { $in: ids }, status: "verified" },
      { $set: { status: "processing", payoutId: payout._id } },
    );
    try {
      const res = await xen.createPayout({
        referenceId,
        channelCode: r.channelCode,
        accountNumber: r.accountNumber,
        accountHolderName: r.accountHolderName,
        amount,
        currency: r.currency,
        description: type === "driver" ? "Botlify driver earnings" : "Botlify consultant commission",
      });
      payout.providerPayoutId = res.payoutId;
      await payout.save();
      if (res.status === "SUCCEEDED") await settle(payout, "SUCCEEDED");
      summary.paid++;
    } catch (err) {
      const reason = xen._errText(err);
      logger.warn(`[payouts] ${type} ${who} failed: ${reason}`);
      await fail(payout, reason);
      summary.failed++;
    }
  }
  logger.info(`[payouts] ${type}: paid ${summary.paid}, failed ${summary.failed}, skipped ${summary.skipped.length}`);
  return summary;
}

async function settle(payout, status) {
  const claimed = await Payout.findOneAndUpdate(
    { _id: payout._id, status: "processing" },
    { $set: { status: "succeeded", completedAt: new Date() } },
    { new: true },
  );
  if (!claimed) return;
  void status;
  await CommissionEntry.updateMany(
    { payoutId: claimed._id, status: "processing" },
    { $set: { status: "paid", paidAt: new Date(), paidBy: "auto", payoutReference: `xendit:${claimed.providerPayoutId || claimed.referenceId}` } },
  );
  if (claimed.recipientType === "driver") {
    const Driver = require("../../models/Driver");
    await Driver.updateOne({ _id: claimed.recipientId }, { $inc: { "earnings.paid": claimed.amount } });
  } else {
    // Consultant totals are kept in USD.
    const usd = claimed.sourceCurrency === "USD" ? claimed.sourceAmount : claimed.currency === "USD" ? claimed.amount : 0;
    if (usd) {
      const Consultant = require("../../models/Consultant");
      await Consultant.updateOne({ _id: claimed.recipientId }, { $inc: { "totals.paid": usd } });
    }
  }
  // Receipt on WhatsApp (best-effort).
  try {
    const r = await recipientFor(claimed.recipientType, claimed.recipientId);
    if (r?.phone) {
      const platformWA = require("../channels/platformWhatsApp");
      const amt = `${claimed.currency} ${Number(claimed.amount).toLocaleString("en-US")}`;
      await platformWA.send(r.phone, `💸 Botlify just paid you ${amt} to your ${claimed.channelCode.replace(/^ID_/, "")} account ending ${String(claimed.accountNumber).slice(-4)}. Thank you! 🙏`);
    }
  } catch {
    /* receipt is optional */
  }
}

async function fail(payout, reason) {
  await Payout.updateOne({ _id: payout._id }, { $set: { status: "failed", failureReason: String(reason).slice(0, 300), completedAt: new Date() } });
  // Release the entries so the next run retries once details are fixed.
  await CommissionEntry.updateMany(
    { payoutId: payout._id, status: "processing" },
    { $set: { status: "verified" }, $unset: { payoutId: 1 } },
  );
  const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.ADMIN_EMAIL;
  if (to) {
    try {
      const { sendEmail } = require("../emailService");
      await sendEmail({
        to,
        subject: `⚠️ Payout failed: ${payout.recipientName} (${payout.currency} ${payout.amount})`,
        html: `<p>The ${payout.recipientType} payout to <b>${payout.recipientName}</b> (${payout.channelCode} ${payout.accountNumber}) failed:</p><p>${reason}</p><p>The amount is back in their balance and will retry on the next run once their payout details are corrected.</p>`,
      });
    } catch {
      /* alert is best-effort */
    }
  }
}

/** Xendit payout webhook. */
async function handlePayoutEvent(evt) {
  const payout = await Payout.findOne(
    evt.referenceId ? { referenceId: evt.referenceId } : { providerPayoutId: evt.payoutId },
  );
  if (!payout) return { ok: false, reason: "unknown_payout" };
  if (evt.status === "SUCCEEDED" || evt.status === "COMPLETED") {
    await settle(payout, evt.status);
    return { ok: true, settled: true };
  }
  if (["FAILED", "REVERSED", "CANCELLED", "EXPIRED"].includes(evt.status)) {
    if (payout.status === "processing" || evt.status === "REVERSED") await fail(payout, evt.failureCode || evt.status);
    return { ok: true, failed: true };
  }
  return { ok: true, ignored: evt.status };
}

module.exports = { autoVerify, runPayouts, handlePayoutEvent, convert };
