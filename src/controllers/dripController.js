/**
 * Botlify — Drip Campaigns Controller
 */
const asyncHandler = require("express-async-handler");
const { DripCampaign, DripEnrollment } = require("../models/DripCampaign");
const Contact = require("../models/Contact");

exports.list = asyncHandler(async (req, res) => {
  const campaigns = await DripCampaign.find({ workspaceId: req.workspace._id })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, campaigns });
});

exports.get = asyncHandler(async (req, res) => {
  const c = await DripCampaign.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!c) return res.status(404).json({ message: "Not found" });
  res.json({ success: true, campaign: c });
});

exports.create = asyncHandler(async (req, res) => {
  const { name, description, trigger, steps, enabled } = req.body;
  if (!name || !steps?.length) {
    return res.status(400).json({ message: "name and steps are required" });
  }
  const normalized = steps.map((s, i) => ({
    order: i,
    message: s.message,
    delayMinutes: Number(s.delayMinutes) || 0,
    ctaLabel: s.ctaLabel,
    ctaUrl: s.ctaUrl,
  }));
  const campaign = await DripCampaign.create({
    workspaceId: req.workspace._id,
    name,
    description,
    trigger: trigger || { type: "keyword" },
    steps: normalized,
    enabled: enabled !== false,
  });
  res.status(201).json({ success: true, campaign });
});

exports.update = asyncHandler(async (req, res) => {
  const { name, description, trigger, steps, enabled } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (trigger !== undefined) update.trigger = trigger;
  if (enabled !== undefined) update.enabled = enabled;
  if (Array.isArray(steps)) {
    update.steps = steps.map((s, i) => ({
      order: i,
      message: s.message,
      delayMinutes: Number(s.delayMinutes) || 0,
      ctaLabel: s.ctaLabel,
      ctaUrl: s.ctaUrl,
    }));
  }
  const c = await DripCampaign.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    update,
    { new: true },
  );
  if (!c) return res.status(404).json({ message: "Not found" });
  res.json({ success: true, campaign: c });
});

exports.remove = asyncHandler(async (req, res) => {
  await DripCampaign.deleteOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  await DripEnrollment.deleteMany({
    campaignId: req.params.id,
    workspaceId: req.workspace._id,
  });
  res.json({ success: true });
});

// Manually enroll a contact
exports.enroll = asyncHandler(async (req, res) => {
  const { contactId } = req.body;
  const campaign = await DripCampaign.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });
  const contact = await Contact.findOne({
    _id: contactId,
    workspaceId: req.workspace._id,
  });
  if (!contact) return res.status(404).json({ message: "Contact not found" });

  const firstDelay = campaign.steps[0]?.delayMinutes || 0;
  const enrollment = await DripEnrollment.create({
    workspaceId: req.workspace._id,
    campaignId: campaign._id,
    contactId: contact._id,
    currentStep: 0,
    nextRunAt: new Date(Date.now() + firstDelay * 60 * 1000),
    status: "active",
  });
  campaign.stats.enrolled = (campaign.stats.enrolled || 0) + 1;
  await campaign.save();
  res.json({ success: true, enrollment });
});

exports.enrollments = asyncHandler(async (req, res) => {
  const enrollments = await DripEnrollment.find({
    campaignId: req.params.id,
    workspaceId: req.workspace._id,
  })
    .populate("contactId", "name igUsername")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.json({ success: true, enrollments });
});
