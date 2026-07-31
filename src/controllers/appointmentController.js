/**
 * appointmentController — dashboard-side appointment management.
 *
 *   GET   /:workspaceId/appointments/config   → scheduling settings
 *   PUT   /:workspaceId/appointments/config   → save settings (services/hours/etc)
 *   GET   /:workspaceId/appointments          → list bookings (filter by status/range)
 *   GET   /:workspaceId/appointments/slots    → available slots (preview / manual book)
 *   POST  /:workspaceId/appointments          → create a booking manually
 *   PATCH /:workspaceId/appointments/:id      → update status (confirm/cancel/complete)
 *
 * The bot-driven booking path lives in services/appointments/booking.js.
 */
const asyncHandler = require("express-async-handler");
const Appointment = require("../models/Appointment");
const { getAvailableSlots, isSlotAvailable } = require("../services/appointments/slotEngine");
const logger = require("../utils/logger");

// @GET config
const getConfig = asyncHandler(async (req, res) => {
  const a = req.workspace.appointments || {};
  res.json({
    success: true,
    config: {
      enabled: !!a.enabled,
      services: a.services || [],
      slotMinutes: a.slotMinutes || 30,
      bufferMinutes: a.bufferMinutes ?? 10,
      capacityPerSlot: a.capacityPerSlot || 1,
      advanceDays: a.advanceDays || 30,
      minNoticeHours: a.minNoticeHours ?? 2,
      requireApproval: !!a.requireApproval,
      locationName: a.locationName || "",
      locationAddress: a.locationAddress || "",
      mapsUrl: a.mapsUrl || "",
      notifyEmail: a.notifyEmail || "",
    },
    timezone: req.workspace.timezone || "Asia/Karachi",
    businessHours: req.workspace.businessHours || [],
  });
});

// @PUT config — save scheduling settings.
const saveConfig = asyncHandler(async (req, res) => {
  const ws = req.workspace;
  const b = req.body || {};
  ws.appointments = ws.appointments || {};
  const a = ws.appointments;

  if (b.enabled != null) a.enabled = !!b.enabled;
  if (Array.isArray(b.services))
    a.services = b.services
      .filter((s) => s && String(s.name || "").trim())
      .slice(0, 50)
      .map((s) => ({
        name: String(s.name).trim().slice(0, 100),
        durationMinutes: Math.max(5, Math.min(480, Number(s.durationMinutes) || 30)),
        price: Math.max(0, Number(s.price) || 0),
      }));
  if (b.slotMinutes != null)
    a.slotMinutes = Math.max(5, Math.min(240, Number(b.slotMinutes) || 30));
  if (b.bufferMinutes != null)
    a.bufferMinutes = Math.max(0, Math.min(120, Number(b.bufferMinutes) || 0));
  if (b.capacityPerSlot != null)
    a.capacityPerSlot = Math.max(1, Math.min(50, Number(b.capacityPerSlot) || 1));
  if (b.advanceDays != null)
    a.advanceDays = Math.max(1, Math.min(180, Number(b.advanceDays) || 30));
  if (b.minNoticeHours != null)
    a.minNoticeHours = Math.max(0, Math.min(168, Number(b.minNoticeHours) || 0));
  if (b.requireApproval != null) a.requireApproval = !!b.requireApproval;
  if (b.locationName != null) a.locationName = String(b.locationName).slice(0, 200);
  if (b.locationAddress != null)
    a.locationAddress = String(b.locationAddress).slice(0, 300);
  if (b.mapsUrl != null) a.mapsUrl = String(b.mapsUrl).slice(0, 500);
  if (b.notifyEmail != null) a.notifyEmail = String(b.notifyEmail).slice(0, 200);
  a.lastUpdatedAt = new Date();

  // Let the owner set business hours here too (needed for slot math).
  if (Array.isArray(b.businessHours)) ws.businessHours = b.businessHours;
  if (b.timezone) ws.timezone = String(b.timezone);

  // Turning scheduling on also flips the feature flag so the UI reveals it.
  if (a.enabled) {
    ws.features = ws.features || {};
    ws.features.appointments = true;
  }

  await ws.save();
  res.json({ success: true, config: ws.appointments });
});

// @GET appointments — list bookings, newest upcoming first.
const list = asyncHandler(async (req, res) => {
  const { status, from, to } = req.query;
  const q = { workspaceId: req.workspace._id };
  if (status) q.status = status;
  if (from || to) {
    q.startAt = {};
    if (from) q.startAt.$gte = new Date(from);
    if (to) q.startAt.$lte = new Date(to);
  }
  const appointments = await Appointment.find(q)
    .sort({ startAt: 1 })
    .limit(500)
    .lean();
  res.json({ success: true, appointments });
});

// @GET slots — available slots (dashboard preview / manual booking helper).
const slots = asyncHandler(async (req, res) => {
  const available = await getAvailableSlots(req.workspace, {
    service: req.query.service,
    limit: Number(req.query.limit) || 12,
  });
  res.json({ success: true, slots: available });
});

// @POST appointments — manual booking from the dashboard.
const create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.startAt) {
    res.status(400);
    throw new Error("Please choose a start time.");
  }
  const check = await isSlotAvailable(req.workspace, b.startAt, b.service);
  if (!check.ok && !b.force) {
    res.status(409);
    throw new Error(`That slot isn't available (${check.reason}).`);
  }
  const start = new Date(b.startAt);
  const duration = check.durationMinutes || Number(b.durationMinutes) || 30;
  const appt = await Appointment.create({
    workspaceId: req.workspace._id,
    customerName: b.customerName || "",
    customerPhone: b.customerPhone || "",
    customerEmail: b.customerEmail || "",
    service: check.service || b.service || "",
    durationMinutes: duration,
    startAt: start,
    endAt: check.endAt || new Date(start.getTime() + duration * 60000),
    notes: b.notes || "",
    status: "confirmed",
    source: "manual",
  });
  logger.info(`[appointments] manual booking ws=${req.workspace._id} at=${start.toISOString()}`);
  res.status(201).json({ success: true, appointment: appt });
});

// @PATCH appointments/:id — change status (approve/cancel/complete/no_show).
const update = asyncHandler(async (req, res) => {
  const { status, notes } = req.body || {};
  const allowed = ["pending", "confirmed", "completed", "cancelled", "no_show"];
  const patch = {};
  if (status && allowed.includes(status)) patch.status = status;
  if (notes != null) patch.notes = String(notes);
  const appt = await Appointment.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    patch,
    { new: true },
  );
  if (!appt) {
    res.status(404);
    throw new Error("Appointment not found");
  }
  res.json({ success: true, appointment: appt });
});

module.exports = { getConfig, saveConfig, list, slots, create, update };
