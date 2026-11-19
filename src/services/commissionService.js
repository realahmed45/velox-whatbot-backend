/**
 * commissionService — the money ledger.
 *
 * recordRevenue() writes one `platform_revenue` CommissionEntry per revenue
 * event (SaaS payment, 10% booking commission, transfer margin) and — when the
 * workspace was signed by an approved consultant within their revenue-share
 * window — a linked `consultant_share` entry at 20%.
 *
 * Nothing here moves money. payoutService turns eligible consultant shares and
 * driver earnings into automatic Xendit payouts.
 *
 * Currency note (v1): entries keep the source currency (IDR bookings stay
 * IDR). Consultant denormalized totals only accumulate USD entries; the admin
 * payout screen groups the real amounts per currency.
 */
const CommissionEntry = require("../models/CommissionEntry");
const Consultant = require("../models/Consultant");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const {
  CONSULTANT_REVENUE_SHARE_RATE,
  CONSULTANT_SHARE_MONTHS,
} = require("../config/plans");

const periodOf = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Is this workspace inside an approved consultant's revenue-share window? */
async function activeConsultantFor(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select("acquisition").lean();
  const acq = ws?.acquisition;
  if (!acq?.consultantId || !acq.attributedAt) return null;
  const windowEnd = new Date(acq.attributedAt);
  windowEnd.setMonth(windowEnd.getMonth() + CONSULTANT_SHARE_MONTHS);
  if (new Date() > windowEnd) return null;
  const consultant = await Consultant.findById(acq.consultantId);
  if (!consultant || consultant.status !== "approved") return null;
  return consultant;
}

/**
 * Record a platform revenue event (+ consultant share when applicable).
 *
 * @param {object} p
 * @param {string} p.workspaceId
 * @param {"saas"|"booking_commission"|"transfer_margin"} p.type
 * @param {number} p.amount    amount in p.currency
 * @param {string} [p.currency="USD"]
 * @param {number} [p.rate]    the commission rate that produced this amount
 * @param {string} [p.bookingId] / [p.transferId] / [p.reference]
 * @returns {Promise<CommissionEntry|null>} the platform_revenue entry
 */
async function recordRevenue({
  workspaceId,
  type,
  amount,
  currency = "USD",
  rate,
  sourceAmount,
  sourceCurrency,
  bookingId,
  transferId,
  paymentId,
  reference = "",
  collected = false,
}) {
  if (!workspaceId || !type) return null;
  if (!amount || amount <= 0) return null;

  const period = periodOf();
  const revenue = await CommissionEntry.create({
    paymentId,
    collectedAt: collected ? new Date() : null,
    // Collected at source (Xendit split) = nothing left to invoice.
    ...(collected && type !== "saas" ? { paidAt: new Date() } : {}),
    workspaceId,
    kind: "platform_revenue",
    revenueType: type,
    amount,
    currency,
    rate,
    sourceAmount,
    sourceCurrency,
    bookingId,
    transferId,
    reference,
    period,
    status: collected && type !== "saas" ? "paid" : "accrued",
  });

  // Consultant share (best-effort — a failure here must never block revenue).
  try {
    const consultant = await activeConsultantFor(workspaceId);
    if (consultant) {
      const shareAmount =
        Math.round(amount * CONSULTANT_REVENUE_SHARE_RATE * 100) / 100;
      if (shareAmount > 0) {
        await CommissionEntry.create({
          workspaceId,
          kind: "consultant_share",
          revenueType: type,
          amount: shareAmount,
          currency,
          rate: CONSULTANT_REVENUE_SHARE_RATE,
          bookingId,
          transferId,
          consultantId: consultant._id,
          parentEntryId: revenue._id,
          reference,
          period,
          status: "accrued",
        });
        if (currency === "USD") {
          await Consultant.updateOne(
            { _id: consultant._id },
            { $inc: { "totals.accrued": shareAmount } },
          );
        }
      }
    }
  } catch (err) {
    logger.warn("[commission] consultant share failed", { err: err.message });
  }

  return revenue;
}

/**
 * Void a revenue entry (e.g. the booking got cancelled) together with any
 * un-paid consultant share derived from it. Paid shares are left untouched —
 * clawbacks are a manual admin decision.
 */
async function voidRevenueEntry(entryId, reason = "") {
  if (!entryId) return;
  const entry = await CommissionEntry.findById(entryId);
  if (!entry || entry.status === "void") return;
  entry.status = "void";
  entry.voidReason = reason;
  await entry.save();
  const share = await CommissionEntry.findOne({
    parentEntryId: entry._id,
    kind: "consultant_share",
  });
  if (share && share.status !== "paid" && share.status !== "void") {
    share.status = "void";
    share.voidReason = reason;
    await share.save();
    if (share.currency === "USD" && share.consultantId) {
      await Consultant.updateOne(
        { _id: share.consultantId },
        { $inc: { "totals.accrued": -share.amount } },
      );
    }
  }
}

/** Mark a revenue row as actually received (hotel paid an invoice, split settled…). */
async function markCollected(entryId) {
  if (!entryId) return;
  await CommissionEntry.updateOne(
    { _id: entryId, kind: "platform_revenue", collectedAt: null },
    { $set: { collectedAt: new Date() } },
  );
}

/**
 * A Botlify driver finished a pickup: write what they earned. Idempotent per
 * transfer — a second DONE message or the auto-complete sweep never pays twice.
 */
async function recordDriverEarning({ transfer, driverId, amount, currency }) {
  if (!transfer || !driverId || !(amount > 0)) return null;
  const existing = await CommissionEntry.findOne({ transferId: transfer._id, kind: "driver_earning" });
  if (existing) return existing;
  const entry = await CommissionEntry.create({
    workspaceId: transfer.workspaceId,
    kind: "driver_earning",
    revenueType: "driver_fare",
    amount,
    currency: currency || transfer.currency || "IDR",
    driverId,
    transferId: transfer._id,
    reference: transfer.code || String(transfer._id),
    period: periodOf(),
    status: "accrued",
  });
  const Driver = require("../models/Driver");
  await Driver.updateOne({ _id: driverId }, { $inc: { "earnings.accrued": amount } });
  return entry;
}

module.exports = { recordRevenue, voidRevenueEntry, markCollected, recordDriverEarning, periodOf };
