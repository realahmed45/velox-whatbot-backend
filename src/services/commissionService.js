/**
 * commissionService — the money ledger.
 *
 * recordRevenue() writes one `platform_revenue` CommissionEntry per revenue
 * event (SaaS payment, 10% booking commission, transfer margin) and — when the
 * workspace was signed by an approved consultant within their revenue-share
 * window — a linked `consultant_share` entry at 20%.
 *
 * Payouts are MANUAL. Nothing here moves money; admin verifies entries and
 * marks them paid in the admin panel.
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
  reference = "",
}) {
  if (!workspaceId || !type) return null;
  if (!amount || amount <= 0) return null;

  const period = periodOf();
  const revenue = await CommissionEntry.create({
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
    status: "accrued",
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

module.exports = { recordRevenue, voidRevenueEntry, periodOf };
