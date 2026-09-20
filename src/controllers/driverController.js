/**
 * driverController — the driver roster and the driver-facing job page.
 *
 * Three audiences, deliberately in one file because they share validation:
 *
 *  1. PUBLIC  /api/drive/:token        — what a driver opens from their link.
 *     No login: the token IS the credential, so it is long, random and
 *     rotatable. Never returns another driver's data or anything about the
 *     hotel beyond what is needed to do the job.
 *  2. HOTEL   /api/drivers             — a hotel managing its OWN drivers
 *     (scope "hotel", pinned to their workspace).
 *  3. ADMIN   /api/admin/drivers       — Botlify's shared pool (scope
 *     "platform"), used by hotels that have no taxi service of their own.
 *
 * Identity fields are stored as numbers and expiry dates only. We never take an
 * uploaded document — the less of that we hold, the less there is to leak.
 */
const asyncHandler = require("express-async-handler");
const Driver = require("../models/Driver");
const TransferBooking = require("../models/TransferBooking");
const dispatch = require("../services/transfers/dispatchService");
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

/* ── 1. PUBLIC: the driver's own job page ──────────────────────────────── */

// @GET /api/drive/:token — the jobs waiting for this driver.
const driverJobs = asyncHandler(async (req, res) => {
  const driver = await Driver.findOne({ dispatchToken: req.params.token });
  if (!driver) {
    res.status(404);
    throw new Error("This link is no longer valid. Ask for a new one.");
  }

  // Anything currently offered to them, plus what they've already taken and
  // still have to drive. Past trips are not their problem.
  const [offered, assigned] = await Promise.all([
    TransferBooking.find({
      "dispatch.state": "searching",
      "dispatch.offers": {
        $elemMatch: { driverId: driver._id, outcome: "pending" },
      },
    })
      .sort({ pickupAt: 1 })
      .limit(20),
    TransferBooking.find({
      driverId: driver._id,
      status: { $in: ["confirmed", "pending"] },
      pickupAt: { $gte: new Date(Date.now() - 12 * 3600000) },
    })
      .sort({ pickupAt: 1 })
      .limit(20),
  ]);

  // Only what the driver needs to do the job — no rates, no OTA data.
  const shape = (t) => ({
    id: t._id,
    direction: t.direction,
    pickupAt: t.pickupAt,
    guestName: t.guestName,
    guestPhone: t.driverId ? t.guestPhone : "", // withheld until they accept
    passengers: t.passengers,
    flightNumber: t.flightNumber,
    airportCode: t.airportCode,
    notes: t.notes,
    expiresAt: (t.dispatch?.offers || []).find(
      (o) => String(o.driverId) === String(driver._id) && o.outcome === "pending",
    )?.expiresAt,
  });

  res.json({
    success: true,
    driver: {
      name: driver.name,
      displayName: driver.displayName,
      vehicleLabel: driver.vehicleLabel,
      stats: driver.stats,
    },
    offers: offered.map(shape),
    assigned: assigned.map(shape),
  });
});

// @POST /api/drive/:token/:transferId/accept
const driverAccept = asyncHandler(async (req, res) => {
  const driver = await Driver.findOne({ dispatchToken: req.params.token });
  if (!driver) {
    res.status(404);
    throw new Error("This link is no longer valid.");
  }
  const result = await dispatch.acceptOffer({
    transferId: req.params.transferId,
    driverId: driver._id,
  });
  if (!result.ok) {
    res.status(result.reason === "taken" ? 409 : 400);
    throw new Error(
      result.reason === "taken"
        ? "Another driver already took this job."
        : "That job is no longer open.",
    );
  }
  res.json({
    success: true,
    // Now they have it, they get the guest's number.
    guestPhone: result.transfer.guestPhone,
    transferId: result.transfer._id,
  });
});

// @POST /api/drive/:token/:transferId/decline
const driverDecline = asyncHandler(async (req, res) => {
  const driver = await Driver.findOne({ dispatchToken: req.params.token });
  if (!driver) {
    res.status(404);
    throw new Error("This link is no longer valid.");
  }
  await dispatch.declineOffer({
    transferId: req.params.transferId,
    driverId: driver._id,
  });
  res.json({ success: true });
});

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
  await dispatch.ensureDispatchToken(driver);
  logger.info(`[drivers] hotel driver created ws=${req.workspace._id} id=${driver._id}`);
  res.status(201).json({
    success: true,
    driver,
    dispatchLink: dispatch.driverLink(driver.dispatchToken),
  });
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

/** Hand back the driver's private link, or mint a fresh one if it leaked. */
const hotelDriverLink = asyncHandler(async (req, res) => {
  const driver = await Driver.findOne({
    _id: req.params.id,
    scope: "hotel",
    workspaceId: req.workspace._id,
  });
  if (!driver) {
    res.status(404);
    throw new Error("Driver not found.");
  }
  const token =
    req.query.rotate === "1"
      ? await dispatch.rotateDispatchToken(driver)
      : await dispatch.ensureDispatchToken(driver);
  res.json({ success: true, link: dispatch.driverLink(token) });
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
  await dispatch.ensureDispatchToken(driver);
  logger.info(`[drivers] platform driver created id=${driver._id}`);
  res.status(201).json({
    success: true,
    driver,
    dispatchLink: dispatch.driverLink(driver.dispatchToken),
  });
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

const platformDriverLink = asyncHandler(async (req, res) => {
  const driver = await Driver.findOne({
    _id: req.params.id,
    scope: "platform",
  });
  if (!driver) {
    res.status(404);
    throw new Error("Driver not found.");
  }
  const token =
    req.query.rotate === "1"
      ? await dispatch.rotateDispatchToken(driver)
      : await dispatch.ensureDispatchToken(driver);
  res.json({ success: true, link: dispatch.driverLink(token) });
});

module.exports = {
  driverJobs,
  driverAccept,
  driverDecline,
  listHotelDrivers,
  createHotelDriver,
  updateHotelDriver,
  deleteHotelDriver,
  hotelDriverLink,
  listPlatformDrivers,
  createPlatformDriver,
  updatePlatformDriver,
  deletePlatformDriver,
  platformDriverLink,
};
