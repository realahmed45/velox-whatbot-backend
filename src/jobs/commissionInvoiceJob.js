/**
 * commissionInvoiceJob — monthly statement for booking commissions.
 *
 * The 10% we charge on bot-closed bookings (and any transfer margin) accrues in
 * the CommissionEntry ledger as we earn it. Once a month this job closes the
 * previous period: it sums each workspace's accrued platform_revenue that isn't
 * SaaS (SaaS is already collected by Creem), emails the hotel a statement, and
 * flips those entries to "invoiced" so they're never billed twice.
 *
 * Payment itself is manual for now (bank transfer / next-invoice settlement) —
 * this job produces the statement and the audit trail, not a charge.
 */
const logger = require("../utils/logger");

/** Previous calendar month as "YYYY-MM". */
function previousPeriod(now = new Date()) {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function sendCommissionInvoices(period = previousPeriod()) {
  const CommissionEntry = require("../models/CommissionEntry");
  const Workspace = require("../models/Workspace");
  const { sendEmail } = require("../services/emailService");

  // Everything we earned that isn't the subscription itself.
  const groups = await CommissionEntry.aggregate([
    {
      $match: {
        kind: "platform_revenue",
        revenueType: { $in: ["booking_commission", "transfer_margin"] },
        status: "accrued",
        period,
      },
    },
    {
      $group: {
        _id: { workspaceId: "$workspaceId", currency: "$currency" },
        total: { $sum: "$amount" },
        count: { $sum: 1 },
        ids: { $push: "$_id" },
      },
    },
  ]);

  if (!groups.length) {
    logger.info(`[commissionInvoice] nothing to invoice for ${period}`);
    return { period, invoiced: 0 };
  }

  // One email per workspace, even when it has several currencies.
  const byWorkspace = new Map();
  for (const g of groups) {
    const key = String(g._id.workspaceId);
    if (!byWorkspace.has(key)) byWorkspace.set(key, []);
    byWorkspace.get(key).push({
      currency: g._id.currency,
      total: Math.round(g.total * 100) / 100,
      count: g.count,
      ids: g.ids,
    });
  }

  let invoiced = 0;
  for (const [workspaceId, lines] of byWorkspace) {
    const ws = await Workspace.findById(workspaceId)
      .select("name owner")
      .populate("owner", "name email");
    const to = ws?.owner?.email;
    const rows = lines
      .map(
        (l) =>
          `<tr><td style="padding:6px">${l.count} booking${l.count > 1 ? "s" : ""}</td>` +
          `<td style="padding:6px"><b>${l.currency} ${l.total}</b></td></tr>`,
      )
      .join("");
    const textLines = lines
      .map((l) => `  ${l.count} booking(s): ${l.currency} ${l.total}`)
      .join("\n");

    if (to) {
      try {
        await sendEmail({
          to,
          subject: `Botlify statement — ${period} booking commissions`,
          text:
            `Hi ${ws?.owner?.name || "there"},\n\n` +
            `Here's your Botlify statement for ${period}.\n\n` +
            `Commission on bookings our AI closed for you (10%):\n${textLines}\n\n` +
            `Bookings that came from Booking.com or Airbnb are never charged — those stay 0%.\n\n` +
            `We'll be in touch to settle this amount.\n`,
          html:
            `<h2>Botlify statement — ${period}</h2>` +
            `<p>Commission on bookings our AI closed for you (10%):</p>` +
            `<table cellpadding="6" style="border-collapse:collapse">${rows}</table>` +
            `<p style="color:#555">Bookings from Booking.com or Airbnb are never charged — those stay 0%.</p>`,
        });
      } catch (e) {
        logger.warn("[commissionInvoice] email failed", {
          workspaceId,
          err: e.message,
        });
      }
    }

    // Mark the entries invoiced regardless of email success — the ledger is the
    // source of truth and must not double-bill on the next run.
    const ids = lines.flatMap((l) => l.ids);
    await CommissionEntry.updateMany(
      { _id: { $in: ids } },
      { $set: { status: "invoiced" } },
    );
    invoiced += ids.length;
  }

  logger.info(
    `[commissionInvoice] ${period}: invoiced ${invoiced} entries across ${byWorkspace.size} workspace(s)`,
  );
  return { period, invoiced, workspaces: byWorkspace.size };
}

module.exports = { sendCommissionInvoices, previousPeriod };
