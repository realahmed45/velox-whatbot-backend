/**
 * transferController — dashboard-side airport transfer management.
 *
 *   GET   /api/transfers            → list (filters: status, from, to)
 *   POST  /api/transfers            → create manually (goes through transferService)
 *   PATCH /api/transfers/:id/status → update status (+ cancel on Mozio when needed)
 *
 * The bot-driven path calls services/transfers/transferService directly.
 */
const asyncHandler = require("express-async-handler");
const TransferBooking = require("../models/TransferBooking");
const Property = require("../models/Property");
const { createTransfer } = require("../services/transfers/transferService");
const mozioService = require("../services/transfers/mozioService");
const logger = require("../utils/logger");
const { assignDriver } = require("../services/transfers/dispatchService");

const STATUSES = ["pending", "confirmed", "completed", "cancelled", "failed"];

// @GET / — list transfers, soonest pickup first (desc), optional filters.
const list = asyncHandler(async (req, res) => {
  const { status, from, to } = req.query;
  const q = { workspaceId: req.workspace._id };
  if (status) q.status = status;
  if (from || to) {
    q.pickupAt = {};
    if (from) q.pickupAt.$gte = new Date(from);
    if (to) q.pickupAt.$lte = new Date(to);
  }
  const transfers = await TransferBooking.find(q)
    .sort({ pickupAt: -1 })
    .limit(500)
    .lean();
  res.json({ success: true, transfers });
});

// @POST / — manual transfer from the dashboard.
const create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.pickupAt || isNaN(new Date(b.pickupAt).getTime())) {
    res.status(400);
    throw new Error("A valid pickup date/time is required");
  }
  if (b.direction && !["pickup", "dropoff"].includes(b.direction)) {
    res.status(400);
    throw new Error("direction must be 'pickup' or 'dropoff'");
  }

  let property = null;
  if (b.propertyId) {
    property = await Property.findOne({
      _id: b.propertyId,
      workspaceId: req.workspace._id,
    });
    if (!property) {
      res.status(404);
      throw new Error("Property not found");
    }
  }

  const result = await createTransfer({
    workspace: req.workspace,
    property,
    transfer: {
      direction: b.direction || "pickup",
      pickupAt: b.pickupAt,
      flightNumber: b.flightNumber || "",
      guestName: b.guestName || "",
      guestPhone: b.guestPhone || "",
      passengers: b.passengers,
    },
  });

  if (!result.ok) {
    res.status(400);
    throw new Error(
      result.reason === "no_property"
        ? "No active property found — add a property first"
        : `Could not create transfer (${result.reason})`,
    );
  }

  res.status(201).json({
    success: true,
    transfer: result.transfer,
    confirmationText: result.confirmationText,
  });
});

// @PATCH /:id/status — confirm / complete / cancel a transfer.
const updateStatus = asyncHandler(async (req, res) => {
  const { status, notes } = req.body || {};
  if (!STATUSES.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of: ${STATUSES.join(", ")}`);
  }

  const transfer = await TransferBooking.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!transfer) {
    res.status(404);
    throw new Error("Transfer not found");
  }

  // Cancelling a Mozio-booked ride → best-effort cancel upstream too.
  if (
    status === "cancelled" &&
    transfer.provider === "mozio" &&
    transfer.mozioReservationId
  ) {
    const cancel = await mozioService.cancelReservation(
      transfer.mozioReservationId,
    );
    if (!cancel.ok) {
      logger.warn("[transfer] mozio cancel failed", {
        transferId: String(transfer._id),
        err: cancel.error,
      });
    }
  }

  transfer.status = status;
  if (notes != null) transfer.notes = String(notes).slice(0, 2000);
  await transfer.save();

  // Best-effort socket update so the dashboard refreshes live.
  try {
    const { getIO } = require("../socket");
    getIO()
      ?.to(`workspace:${req.workspace._id}`)
      .emit("transfer:changed", {
        transferId: String(transfer._id),
        status: transfer.status,
        event: "status_updated",
      });
  } catch {
    /* socket not ready */
  }

  res.json({ success: true, transfer });
});

// @PATCH /:id/driver — the hotel puts one of its own drivers on a pickup.
// The guest is sent the driver's name, car and WhatsApp number straight away.
const setDriver = asyncHandler(async (req, res) => {
  const t = await TransferBooking.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!t) {
    res.status(404);
    throw new Error("Pickup not found.");
  }
  if (t.provider === "platform") {
    res.status(400);
    throw new Error("Botlify is arranging this driver for you.");
  }
  const r = await assignDriver({
    transferId: t._id,
    driverId: req.body?.driverId,
    scope: "hotel",
    workspaceId: req.workspace._id,
  });
  if (!r.ok) {
    res.status(r.reason === "closed" ? 400 : 404);
    throw new Error(
      r.reason === "closed"
        ? "This pickup is already finished or cancelled."
        : "Pick one of your active drivers.",
    );
  }
  res.json({ success: true, transfer: r.transfer, guestTold: r.guestTold });
});

module.exports = { list, create, updateStatus, setDriver };
