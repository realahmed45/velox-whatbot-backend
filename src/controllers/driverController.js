/**
 * driverController — the driver roster, and assigning Botlify drivers.
 *
 * Two audiences, deliberately in one file because they share validation:
 *
 *  HOTEL  /api/drivers        — a hotel managing its OWN drivers (scope
 *                               "hotel", pinned to their workspace).
 *  ADMIN  /api/admin/drivers  — Botlify's shared pool (scope "platform"),
 *         /api/admin/transfers  used by hotels with no taxi service of their
 *                               own, and the pickups waiting for one of them.
 *
 * Identity fields are stored as numbers and expiry dates only. We never take an
 * uploaded document — the less of that we hold, the less there is to leak.
 */
const asyncHandler = require("express-async-handler");
const Driver = require("../models/Driver");
const TransferBooking = require("../models/TransferBooking");
const { assignDriver } = require("../services/transfers/dispatchService");
const logger = require("../utils/logger");

const ID_TYPES = ["ktp", "passport", "driving_licence", "other"];

/** Pull only fields a client is allowed to set. */
function pickDriverFields(body = {}) {
  const out = {};
  const str = (k) => {
    if (body[k] !== undefined) out[k] = String(body[k]).trim();
  };
  ["name", "nickname", "phone", "email", "idNumber", "licenceNumber", "notes",
   "photoUrl", "suspendedReason"].forEach(str);

  if (body.idType !== undefined && ID_TYPES.includes(body.idType)) {
    out.idType = body.idType;
  }
  ["idExpiry", "licenceExpiry"].forEach((k) => {
    if (body[k] !== undefined) {
      const d = body[k] ? new Date(body[k]) : null;
      out[k] = d && !isNaN(d.getTime()) ? d : null;
    }
  });
  if (body.languages !== undefined) {
    out.languages = Array.isArray(body.languages)
      ? body.languages.map((s) => String(s).trim()).filter(Boolean)
      : [];
  }
  if (body.serviceAreas !== undefined) {
    out.serviceAreas = Array.isArray(body.serviceAreas)
      ? body.serviceAreas.map((s) => String(s).trim()).filter(Boolean)
      : [];
  }
  // findOneAndUpdate skips the model's save hook, so keep the lookup copy here.
  if (out.phone !== undefined) out.phoneDigits = out.phone.replace(/[^\d]/g, "");
  // Where automatic payouts go (Xendit channel code, e.g. ID_BCA / ID_GOPAY).
  if (body.payout && typeof body.payout === "object") {
    out.payout = {
      channelCode: String(body.payout.channelCode || "").trim().toUpperCase().slice(0, 40),
      accountNumber: String(body.payout.accountNumber || "").replace(/\s/g, "").slice(0, 40),
      accountHolderName: String(body.payout.accountHolderName || "").trim().slice(0, 100),
    };
  }
  if (body.priority !== undefined) out.priority = Number(body.priority) || 100;
  if (body.active !== undefined) out.active = !!body.active;
  if (body.vehicle && typeof body.vehicle === "object") {
    out.vehicle = {
      make: String(body.vehicle.make || "").trim(),
      model: String(body.vehicle.model || "").trim(),
      colour: String(body.vehicle.colour || "").trim(),
      plate: String(body.vehicle.plate || "").trim(),
      seats: Number(body.vehicle.seats) || 4,
    };
  }
  return out;
}

/** A name and a working phone are the minimum to dispatch anyone. */
function validate(fields, { isCreate }) {
  if (isCreate && !fields.name) return "A driver needs a name.";
  if (isCreate && !fields.phone) return "A driver needs a phone number.";
  if (fields.phone && !/^\+?[0-9 ()-]{6,20}$/.test(fields.phone)) {
    return "That phone number doesn't look right. Use the full international number.";
  }
  return null;
}

/* ── 2. HOTEL: the hotel's own drivers ─────────────────────────────────── */

const listHotelDrivers = asyncHandler(async (req, res) => {
  const drivers = await Driver.find({
    scope: "hotel",
    workspaceId: req.workspace._id,
  }).sort({ priority: 1, createdAt: 1 });
  res.json({ success: true, drivers });
});

const createHotelDriver = asyncHandler(async (req, res) => {
  const fields = pickDriverFields(req.body);
  const bad = validate(fields, { isCreate: true });
  if (bad) {
    res.status(400);
    throw new Error(bad);
  }
  const driver = await Driver.create({
    ...fields,
    scope: "hotel",
    workspaceId: req.workspace._id,
  });
  logger.info(`[drivers] hotel driver created ws=${req.workspace._id} id=${driver._id}`);
  res.status(201).json({ success: true, driver });
});

const updateHotelDriver = asyncHandler(async (req, res) => {
  const fields = pickDriverFields(req.body);
  const bad = validate(fields, { isCreate: false });
  if (bad) {
    res.status(400);
    throw new Error(bad);
  }
  const driver = await Driver.findOneAndUpdate(
    { _id: req.params.id, scope: "hotel", workspaceId: req.workspace._id },
    { $set: fields },
    { new: true },
  );
  if (!driver) {
    res.status(404);
    throw new Error("Driver not found.");
  }
  res.json({ success: true, driver });
});

const deleteHotelDriver = asyncHandler(async (req, res) => {
  const driver = await Driver.findOneAndDelete({
    _id: req.params.id,
    scope: "hotel",
    workspaceId: req.workspace._id,
  });
  if (!driver) {
    res.status(404);
    throw new Error("Driver not found.");
  }
  res.json({ success: true });
});

/* ── 3. ADMIN: Botlify's shared driver pool ────────────────────────────── */

const listPlatformDrivers = asyncHandler(async (req, res) => {
  const drivers = await Driver.find({ scope: "platform" }).sort({
    priority: 1,
    createdAt: 1,
  });
  res.json({ success: true, drivers });
});

const createPlatformDriver = asyncHandler(async (req, res) => {
  const fields = pickDriverFields(req.body);
  const bad = validate(fields, { isCreate: true });
  if (bad) {
    res.status(400);
    throw new Error(bad);
  }
  const driver = await Driver.create({
    ...fields,
    scope: "platform",
    workspaceId: null,
  });
  logger.info(`[drivers] platform driver created id=${driver._id}`);
  res.status(201).json({ success: true, driver });
});

const updatePlatformDriver = asyncHandler(async (req, res) => {
  const fields = pickDriverFields(req.body);
  const bad = validate(fields, { isCreate: false });
  if (bad) {
    res.status(400);
    throw new Error(bad);
  }
  const driver = await Driver.findOneAndUpdate(
    { _id: req.params.id, scope: "platform" },
    { $set: fields },
    { new: true },
  );
  if (!driver) {
    res.status(404);
    throw new Error("Driver not found.");
  }
  res.json({ success: true, driver });
});

const deletePlatformDriver = asyncHandler(async (req, res) => {
  const driver = await Driver.findOneAndDelete({
    _id: req.params.id,
    scope: "platform",
  });
  if (!driver) {
    res.status(404);
    throw new Error("Driver not found.");
  }
  res.json({ success: true });
});

/* ── 4. ADMIN: pickups waiting for a Botlify driver ──────────────────── */

// @GET /api/admin/transfers — Botlify-driver pickups, open ones first.
const listPlatformTransfers = asyncHandler(async (req, res) => {
  const Property = require("../models/Property");
  const transfers = await TransferBooking.find({
    provider: "platform",
    status: { $in: ["pending", "confirmed"] },
    pickupAt: { $gte: new Date(Date.now() - 24 * 3600000) },
  })
    .sort({ pickupAt: 1 })
    .limit(200)
    .lean();
  const props = await Property.find({
    _id: { $in: [...new Set(transfers.map((t) => String(t.propertyId)))] },
  })
    .select("name city")
    .lean();
  const byId = Object.fromEntries(props.map((p) => [String(p._id), p]));
  res.json({
    success: true,
    transfers: transfers.map((t) => ({
      ...t,
      property: byId[String(t.propertyId)] || null,
    })),
  });
});

// @PATCH /api/admin/transfers/:id/driver — put a Botlify driver on a pickup.
const assignPlatformDriver = asyncHandler(async (req, res) => {
  const r = await assignDriver({
    transferId: req.params.id,
    driverId: req.body?.driverId,
    scope: "platform",
  });
  if (!r.ok) {
    res.status(r.reason === "closed" ? 400 : 404);
    throw new Error(
      r.reason === "closed"
        ? "This pickup is already finished or cancelled."
        : "Pick an active Botlify driver.",
    );
  }
  res.json({ success: true, transfer: r.transfer, guestTold: r.guestTold });
});

module.exports = {
  listHotelDrivers,
  createHotelDriver,
  updateHotelDriver,
  deleteHotelDriver,
  listPlatformDrivers,
  createPlatformDriver,
  updatePlatformDriver,
  deletePlatformDriver,
  listPlatformTransfers,
  assignPlatformDriver,
};
