/**
 * Botlify Payments — hotel side + Xendit webhook.
 *
 *   GET   /api/payments/status        → hotel's payment account + settings
 *   POST  /api/payments/connect       { email } → create Xendit sub-account
 *                                     (Xendit emails the hotel to finish KYC)
 *   POST  /api/payments/refresh       → re-read the account status from Xendit
 *   PATCH /api/payments/settings      { collectOnline, depositPercent }
 *   POST  /api/payments/link          { amount, currency?, description, bookingId? }
 *   GET   /api/payments               → this hotel's recent payments
 *   POST  /api/payments/xendit/webhook  (public, x-callback-token) invoices + payouts
 */
const asyncHandler = require("express-async-handler");
const logger = require("../utils/logger");
const Workspace = require("../models/Workspace");
const Payment = require("../models/Payment");
const xen = require("../services/payments/xenPlatformService");
const paymentService = require("../services/payments/paymentService");

const view = (ws) => {
  const p = ws.payments || {};
  return {
    available: xen.isConfigured(),
    connected: !!p.accountId,
    status: p.accountStatus || null,
    live: paymentService.hotelReady(ws),
    email: p.email || null,
    collectOnline: p.collectOnline !== false,
    depositPercent: p.depositPercent || 100,
    feeRates: {
      stays: require("../config/plans").SOCIAL_BOOKING_COMMISSION_RATE,
      pickups: require("../services/transfers/pricing").hotelTransferFeeRate(),
      links: Number(process.env.HOTEL_PAYMENT_FEE_RATE || 0.03),
    },
  };
};

exports.status = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).lean();
  res.json(view(ws));
});

exports.connect = asyncHandler(async (req, res) => {
  if (!xen.isConfigured()) return res.status(503).json({ message: "Online payments aren't switched on yet. Please try again later." });
  const ws = await Workspace.findById(req.workspace._id).populate("owner", "email");
  if (ws.payments?.accountId) return res.json(view(ws));
  const email = String(req.body?.email || ws.owner?.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ message: "Enter the email address for the hotel's payment account." });
  try {
    const acct = await xen.createSubAccount({ email, businessName: ws.name });
    ws.payments = {
      ...(ws.payments?.toObject?.() || {}),
      provider: "xendit",
      accountId: acct.accountId,
      accountStatus: acct.status,
      email,
      connectedAt: new Date(),
    };
    await ws.save();
    logger.info(`[payments] sub-account ${acct.accountId} created for ws=${ws._id}`);
    res.json({ ...view(ws), message: `Xendit has emailed ${email} to verify the business. Once that's done, guests can pay online.` });
  } catch (err) {
    logger.warn(`[payments] connect failed ws=${ws._id}: ${xen._errText(err)}`);
    res.status(400).json({ message: xen._errText(err) || "Couldn't create the payment account." });
  }
});

/** Pull the latest status; flips to LIVE once the hotel finished KYC. */
async function refreshWorkspace(ws) {
  if (!ws.payments?.accountId || !xen.isConfigured()) return ws;
  const { status } = await xen.getSubAccount(ws.payments.accountId);
  if (status && status !== ws.payments.accountStatus) {
    const goingLive = status === "LIVE" && ws.payments.accountStatus !== "LIVE";
    await Workspace.updateOne(
      { _id: ws._id },
      { $set: { "payments.accountStatus": status, ...(goingLive ? { "payments.liveAt": new Date() } : {}) } },
    );
    ws.payments.accountStatus = status;
    if (goingLive) {
      const { notify } = require("../services/notificationService");
      notify(ws._id, {
        type: "payments.live",
        title: "Online payments are live 🎉",
        body: "Guests who book through your AI now get a secure payment link. Money goes straight to your account.",
        link: "/dashboard/settings?tab=payments",
        priority: "high",
        dedupeKey: "payments:live",
      });
    }
  }
  return ws;
}
exports.refreshWorkspace = refreshWorkspace;

exports.refresh = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id);
  try {
    await refreshWorkspace(ws);
  } catch (err) {
    return res.status(400).json({ message: xen._errText(err) });
  }
  res.json(view(ws));
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const set = {};
  if (req.body?.collectOnline !== undefined) set["payments.collectOnline"] = !!req.body.collectOnline;
  if (req.body?.depositPercent !== undefined) {
    const d = Math.round(Number(req.body.depositPercent));
    if (!(d >= 10 && d <= 100)) return res.status(400).json({ message: "Deposit must be between 10% and 100%." });
    set["payments.depositPercent"] = d;
  }
  await Workspace.updateOne({ _id: req.workspace._id }, { $set: set });
  const ws = await Workspace.findById(req.workspace._id).lean();
  res.json(view(ws));
});

exports.createLink = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id);
  if (!paymentService.hotelReady(ws)) return res.status(400).json({ message: "Finish setting up online payments first (Settings → Payments)." });
  const amount = Number(req.body?.amount);
  if (!(amount > 0)) return res.status(400).json({ message: "Enter an amount." });
  const payment = await paymentService.createExtraPaymentLink({
    workspace: ws,
    amount,
    currency: req.body?.currency,
    description: req.body?.description,
    bookingId: req.body?.bookingId || undefined,
  });
  if (!payment) return res.status(502).json({ message: "Couldn't create the payment link — please try again." });
  res.json({ success: true, payment });
});

exports.list = asyncHandler(async (req, res) => {
  const payments = await Payment.find({ workspaceId: req.workspace._id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ payments });
});

// Public: Xendit invoice + payout callbacks.
exports.webhook = async (req, res) => {
  if (!xen.verifyCallback(req)) {
    logger.warn("[payments] Xendit webhook with bad callback token — dropped");
    return res.status(401).json({ error: "invalid token" });
  }
  const evt = xen.parseCallback(req.body || {});
  res.status(200).json({ received: true }); // ack fast; Xendit retries non-2xx
  if (!evt) return;
  try {
    if (evt.type === "invoice") await paymentService.handleInvoiceEvent(evt);
    else if (evt.type === "payout") await require("../services/payments/payoutService").handlePayoutEvent(evt);
  } catch (err) {
    logger.error(`[payments] webhook processing failed: ${err.message}`);
  }
};
