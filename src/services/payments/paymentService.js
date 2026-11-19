/**
 * paymentService — every guest payment through Botlify, fully automatic.
 *
 *   AI books a stay  → payment link (hotel sub-account, Botlify's commission
 *                      split off on settlement) → guest pays → booking marked
 *                      paid, commission marked collected, guest + hotel told.
 *   AI books pickup  → payment link → guest pays → drivers are offered the job
 *                      on WhatsApp automatically (autoDispatchService).
 *   Hotel bills extra→ payment link from the dashboard, same split.
 *
 * When a hotel hasn't finished Xendit onboarding (or Xendit isn't configured)
 * nothing breaks: no link is sent, the guest pays at the property, and the
 * commission is billed on the monthly statement exactly as before.
 */
const logger = require("../../utils/logger");
const Payment = require("../../models/Payment");
const xen = require("./xenPlatformService");

const clientUrl = () => (process.env.CLIENT_URL || "https://www.botlify.site").replace(/\/$/, "");
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
/** Botlify's fee on links a hotel sends itself from the dashboard (0..1). */
const hotelLinkFeeRate = () => Math.min(0.5, Math.max(0, num(process.env.HOTEL_PAYMENT_FEE_RATE, 0.03)));
const round = (n, currency) => xen.roundFor(n, currency);

/** Can this hotel take money through Botlify right now? */
function hotelReady(workspace) {
  const p = workspace?.payments || {};
  return xen.isConfigured() && p.provider === "xendit" && !!p.accountId && p.accountStatus === "LIVE";
}

/**
 * Create the Payment row + the Xendit link. Never throws — a failure returns
 * null and the caller falls back to "pay at the property".
 */
async function createLink({
  workspace,
  purpose,
  amount,
  currency,
  receiver,
  feeRate = 0,
  description,
  bookingId,
  transferId,
  conversationId,
  customer = {},
}) {
  amount = round(amount, currency);
  if (!(amount > 0) || !xen.isConfigured()) return null;
  if (receiver === "hotel" && !hotelReady(workspace)) return null;

  const platformFee = receiver === "platform" ? amount : round(amount * feeRate, currency);
  const payment = await Payment.create({
    workspaceId: workspace._id,
    purpose,
    bookingId,
    transferId,
    conversationId,
    description,
    amount,
    currency,
    receiver,
    feeRate: receiver === "platform" ? 1 : feeRate,
    platformFee,
    netToReceiver: receiver === "platform" ? amount : round(amount - platformFee, currency),
    providerAccountId: receiver === "hotel" ? workspace.payments.accountId : null,
  });

  try {
    const splitRuleId =
      receiver === "hotel" && feeRate > 0 ? await xen.splitRuleFor(feeRate * 100, currency) : null;
    const inv = await xen.createInvoice({
      externalId: String(payment._id),
      amount,
      currency,
      description,
      payerEmail: customer.email || undefined,
      customerName: customer.name || undefined,
      customerPhone: customer.phone || undefined,
      forUserId: receiver === "hotel" ? workspace.payments.accountId : undefined,
      splitRuleId,
      successUrl: `${clientUrl()}/pay/thanks`,
      failureUrl: `${clientUrl()}/pay/failed`,
    });
    payment.invoiceId = inv.invoiceId;
    payment.url = inv.url;
    payment.splitRuleId = splitRuleId;
    payment.expiresAt = inv.expiresAt;
    await payment.save();
    logger.info(`[payments] link ${payment._id} ${purpose} ${currency} ${amount} → ${receiver}`);
    return payment;
  } catch (err) {
    logger.warn(`[payments] link creation failed (${purpose}): ${xen._errText(err)}`);
    payment.status = "failed";
    await payment.save().catch(() => {});
    return null;
  }
}

/** Payment link for a bot-closed stay. Returns the Payment or null. */
async function createStayPaymentLink({ workspace, booking }) {
  const p = workspace?.payments || {};
  if (!hotelReady(workspace) || p.collectOnline === false) return null;
  if (!(booking.totalAmount > 0)) return null;
  const pct = Math.min(100, Math.max(10, Number(p.depositPercent) || 100));
  const charge = round((booking.totalAmount * pct) / 100, booking.currency);
  // Botlify's whole commission is taken from what the guest pays online, so a
  // deposit carries a proportionally higher split percentage.
  const commission = Number(booking.commission?.amount) || 0;
  const feeRate = charge > 0 ? Math.min(0.99, Math.round((commission / charge) * 10000) / 10000) : 0;
  const payment = await createLink({
    workspace,
    purpose: "stay",
    amount: charge,
    currency: booking.currency,
    receiver: "hotel",
    feeRate,
    description: `${pct < 100 ? `${pct}% deposit` : "Payment"} for booking ${booking.code}`,
    bookingId: booking._id,
    conversationId: booking.conversationId,
    customer: { name: booking.guestName, email: booking.guestEmail, phone: booking.guestPhone },
  });
  if (payment) {
    const HotelBooking = require("../../models/HotelBooking");
    await HotelBooking.updateOne(
      { _id: booking._id },
      { $set: { "payment.paymentId": payment._id, "payment.linkUrl": payment.url } },
    );
  }
  return payment;
}

/** Link for a pickup. Platform trips → Botlify; hotel-run → hotel minus fee. */
async function createTransferPaymentLink({ workspace, transfer }) {
  const isPlatform = transfer.provider === "platform";
  const { hotelTransferFeeRate } = require("../transfers/pricing");
  const what = transfer.direction === "pickup" ? "Airport pickup" : "Airport drop-off";
  return createLink({
    workspace,
    purpose: "transfer",
    amount: transfer.price,
    currency: transfer.currency,
    receiver: isPlatform ? "platform" : "hotel",
    feeRate: isPlatform ? 1 : hotelTransferFeeRate(),
    description: `${what} ${transfer.code}`,
    transferId: transfer._id,
    conversationId: transfer.conversationId,
    customer: { name: transfer.guestName, phone: transfer.guestPhone },
  });
}

/** Hotel-initiated link from the dashboard (deposit, extras, anything). */
async function createExtraPaymentLink({ workspace, amount, currency, description, bookingId }) {
  let conversationId;
  let customer = {};
  if (bookingId) {
    const HotelBooking = require("../../models/HotelBooking");
    const b = await HotelBooking.findOne({ _id: bookingId, workspaceId: workspace._id }).lean();
    if (b) {
      conversationId = b.conversationId;
      customer = { name: b.guestName, email: b.guestEmail, phone: b.guestPhone };
      currency = currency || b.currency;
    }
  }
  return createLink({
    workspace,
    purpose: "extra",
    amount,
    currency: currency || "IDR",
    receiver: "hotel",
    feeRate: hotelLinkFeeRate(),
    description: String(description || "Payment").slice(0, 200),
    bookingId,
    conversationId,
    customer,
  });
}

// ── Webhook: a payment link was paid / expired ──────────────────────────────

const money = (currency, amount) =>
  `${currency} ${Number(amount).toLocaleString("en-US", { maximumFractionDigits: currency === "IDR" ? 0 : 2 })}`;

async function handleInvoiceEvent(evt) {
  let payment = null;
  if (/^[a-f0-9]{24}$/i.test(evt.externalId || "")) payment = await Payment.findById(evt.externalId);
  if (!payment && evt.invoiceId) payment = await Payment.findOne({ invoiceId: evt.invoiceId });
  if (!payment) {
    logger.warn(`[payments] callback for unknown payment ${evt.externalId}`);
    return { ok: false, reason: "unknown_payment" };
  }

  if (evt.status === "PAID" || evt.status === "SETTLED") {
    // Atomic flip: Xendit sends PAID then SETTLED (and retries) — act once.
    const claimed = await Payment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ["pending", "expired", "failed"] } },
      { $set: { status: "paid", paidAt: new Date(), method: evt.method || "" } },
      { new: true },
    );
    if (!claimed) return { ok: true, duplicate: true };
    await onPaid(claimed);
    return { ok: true, paid: true };
  }
  if (evt.status === "EXPIRED") {
    await Payment.updateOne({ _id: payment._id, status: "pending" }, { $set: { status: "expired" } });
    await onExpired(payment);
    return { ok: true, expired: true };
  }
  return { ok: true, ignored: evt.status };
}

async function onPaid(payment) {
  const { recordRevenue, markCollected } = require("../commissionService");
  const { messageGuest } = require("../messaging/guestMessenger");
  const { notify } = require("../notificationService");

  if (payment.purpose === "stay" && payment.bookingId) {
    const HotelBooking = require("../../models/HotelBooking");
    const CommissionEntry = require("../../models/CommissionEntry");
    const booking = await HotelBooking.findById(payment.bookingId);
    if (booking) {
      const full = payment.amount >= round(booking.totalAmount, booking.currency);
      booking.payment.status = full ? "paid" : "deposit";
      booking.payment.method = payment.method || "online";
      booking.payment.paidAt = payment.paidAt;
      await booking.save();
      // The commission was split off at source: collected, nothing to invoice.
      if (booking.commission?.ledgerEntryId) {
        await markCollected(booking.commission.ledgerEntryId);
        await CommissionEntry.updateOne(
          { _id: booking.commission.ledgerEntryId, status: { $in: ["accrued", "invoiced"] } },
          { $set: { status: "paid", paidAt: new Date(), paymentId: payment._id, payoutReference: `xendit:${payment.invoiceId}` } },
        );
      }
      notify(payment.workspaceId, {
        type: "payment.received",
        title: `Payment received · ${booking.guestName || "Guest"}`,
        body: `${money(payment.currency, payment.amount)} for ${booking.code}${full ? "" : " (deposit)"} · ${money(payment.currency, payment.netToReceiver)} to you`,
        link: `/dashboard/bookings?code=${booking.code}`,
        priority: "normal",
        dedupeKey: `payment:${payment._id}`,
      });
      if (booking.conversationId) {
        await messageGuest(
          booking.conversationId,
          `Payment received ✅ ${money(payment.currency, payment.amount)} for booking ${booking.code}. ` +
            (full ? "You're all set — see you soon! 🌴" : "The rest is payable at the property. See you soon! 🌴"),
        ).catch(() => {});
      }
    }
    return;
  }

  if (payment.purpose === "transfer" && payment.transferId) {
    const TransferBooking = require("../../models/TransferBooking");
    const transfer = await TransferBooking.findById(payment.transferId);
    if (!transfer) return;
    transfer.paymentStatus = "paid";
    await transfer.save();
    const margin = payment.receiver === "platform"
      ? round(payment.amount - (transfer.driverPayout || 0), payment.currency)
      : payment.platformFee;
    if (margin > 0) {
      const entry = await recordRevenue({
        workspaceId: payment.workspaceId,
        type: "transfer_margin",
        amount: margin,
        currency: payment.currency,
        rate: payment.receiver === "platform" ? undefined : payment.feeRate,
        transferId: transfer._id,
        paymentId: payment._id,
        reference: `xendit:${payment.invoiceId}`,
        collected: true,
      });
      if (entry) await Payment.updateOne({ _id: payment._id }, { $set: { ledgerEntryId: entry._id } });
    }
    if (transfer.conversationId) {
      await messageGuest(
        transfer.conversationId,
        `Payment received ✅ ${money(payment.currency, payment.amount)} for your ${transfer.direction === "pickup" ? "airport pickup" : "airport drop-off"} (${transfer.code}). We're assigning your driver now — you'll get their name and number shortly. 🚗`,
      ).catch(() => {});
    }
    const { startDispatch } = require("../transfers/autoDispatchService");
    await startDispatch(transfer);
    return;
  }

  if (payment.purpose === "extra") {
    if (payment.platformFee > 0) {
      const entry = await recordRevenue({
        workspaceId: payment.workspaceId,
        type: "booking_commission",
        amount: payment.platformFee,
        currency: payment.currency,
        rate: payment.feeRate,
        bookingId: payment.bookingId,
        paymentId: payment._id,
        reference: `xendit:${payment.invoiceId}`,
        collected: true,
      });
      if (entry) await Payment.updateOne({ _id: payment._id }, { $set: { ledgerEntryId: entry._id } });
    }
    notify(payment.workspaceId, {
      type: "payment.received",
      title: "Payment received",
      body: `${money(payment.currency, payment.amount)} · ${payment.description} · ${money(payment.currency, payment.netToReceiver)} to you`,
      link: "/dashboard/bookings",
      priority: "normal",
      dedupeKey: `payment:${payment._id}`,
    });
  }
}

async function onExpired(payment) {
  if (payment.purpose !== "transfer" || !payment.transferId) return;
  const TransferBooking = require("../../models/TransferBooking");
  const t = await TransferBooking.findOneAndUpdate(
    { _id: payment.transferId, paymentStatus: "pending", status: "pending" },
    { $set: { status: "cancelled", notes: "Payment link expired — not paid" } },
    { new: true },
  );
  if (t?.conversationId) {
    const { messageGuest } = require("../messaging/guestMessenger");
    await messageGuest(
      t.conversationId,
      `Your ${t.direction === "pickup" ? "airport pickup" : "drop-off"} request (${t.code}) wasn't paid in time, so it's been released. Just message us if you still need a ride! 🚗`,
    ).catch(() => {});
  }
}

module.exports = {
  hotelReady,
  createStayPaymentLink,
  createTransferPaymentLink,
  createExtraPaymentLink,
  handleInvoiceEvent,
  _internal: { createLink, onPaid },
};
