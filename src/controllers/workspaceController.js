const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const User = require("../models/User");
const { encrypt, decrypt } = require("../utils/encryption");
const { sendTeamInviteEmail } = require("../services/emailService");
const { generateToken } = require("../utils/crypto");

// @POST /api/workspaces — Create workspace
const createWorkspace = asyncHandler(async (req, res) => {
  const {
    name,
    industry: industryField,
    businessType,
    logo,
    businessHours,
    timezone,
  } = req.body;
  const industry = industryField || businessType;
  if (!name || !industry) {
    res.status(400);
    throw new Error("Workspace name and industry are required");
  }

  const defaultHours = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ].map((day) => ({
    day,
    isOpen: !["saturday", "sunday"].includes(day),
    openTime: "09:00",
    closeTime: "18:00",
  }));

  const workspace = await Workspace.create({
    name,
    industry,
    logo,
    businessHours: businessHours || defaultHours,
    timezone: timezone || "Asia/Karachi",
    owner: req.user._id,
  });

  // Add workspace to user
  await User.findByIdAndUpdate(req.user._id, {
    $push: { workspaces: workspace._id },
    activeWorkspace: workspace._id,
  });

  res.status(201).json({ success: true, workspace });
});

// @GET /api/workspaces — List user's workspaces
const getWorkspaces = asyncHandler(async (req, res) => {
  const workspaces = await Workspace.find({
    $or: [{ owner: req.user._id }, { "members.user": req.user._id }],
  });
  res.json({ success: true, workspaces });
});

// @GET /api/workspaces/:workspaceId — Get single workspace
const getWorkspace = asyncHandler(async (req, res) => {
  res.json({ success: true, workspace: req.workspace });
});

// @PUT /api/workspaces/:workspaceId — Update workspace settings
const updateWorkspace = asyncHandler(async (req, res) => {
  const allowed = [
    "name",
    "logo",
    "businessHours",
    "timezone",
    "settings",
    "industry",
    "language",
    "branding",
    "aiSettings",
  ];
  const updates = {};
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  const workspace = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    updates,
    { new: true, runValidators: true },
  );
  res.json({ success: true, workspace });
});


// @POST /api/workspaces/:workspaceId/members/invite — Invite team member
const inviteMember = asyncHandler(async (req, res) => {
  if (req.workspaceRole !== "owner") {
    res.status(403);
    throw new Error("Only owners can invite members");
  }
  const { email, role = "agent" } = req.body;
  if (!email) {
    res.status(400);
    throw new Error("Email required");
  }

  const workspace = req.workspace;
  const inviteToken = generateToken();

  // Check if already a member
  const existingUser = await User.findOne({ email });
  const isAlreadyMember =
    existingUser &&
    (workspace.owner.toString() === existingUser._id.toString() ||
      workspace.members.some(
        (m) => m.user.toString() === existingUser._id.toString(),
      ));
  if (isAlreadyMember) {
    res.status(409);
    throw new Error("User is already a member of this workspace");
  }

  const inviteUrl = `${process.env.CLIENT_URL}/invite?token=${inviteToken}&workspace=${workspace._id}`;
  await sendTeamInviteEmail({
    to: email,
    inviterName: req.user.name,
    workspaceName: workspace.name,
    inviteUrl,
  });

  res.json({ success: true, message: `Invitation sent to ${email}` });
});

// @DELETE /api/workspaces/:workspaceId/members/:userId — Remove team member
const removeMember = asyncHandler(async (req, res) => {
  if (req.workspaceRole !== "owner") {
    res.status(403);
    throw new Error("Only owners can remove members");
  }
  const { userId } = req.params;
  const ws = req.workspace;
  if (ws.owner.toString() === userId) {
    res.status(400);
    throw new Error("Cannot remove the workspace owner");
  }
  ws.members = (ws.members || []).filter((m) => m.user.toString() !== userId);
  await ws.save();
  res.json({ success: true });
});

// @POST /api/workspaces/:workspaceId/complete-onboarding
const completeOnboarding = asyncHandler(async (req, res) => {
  await Workspace.findByIdAndUpdate(req.workspace._id, {
    onboardingCompleted: true,
    onboardingStep: 4,
  });
  await User.findByIdAndUpdate(req.user._id, { onboardingCompleted: true });
  res.json({ success: true, message: "Onboarding completed!" });
});

// @PATCH /api/workspaces/:workspaceId/onboarding-step
const updateOnboardingStep = asyncHandler(async (req, res) => {
  const { step } = req.body;
  await Workspace.findByIdAndUpdate(req.workspace._id, {
    onboardingStep: step,
  });
  res.json({ success: true, step });
});


// @PUT /api/workspaces/:workspaceId/dm-messages — Save DM automation messages
const saveDmMessages = asyncHandler(async (req, res) => {
  const {
    enabled,
    greeting,
    followUp1,
    followUp2,
    followUp3,
    followUpIntervalHours,
  } = req.body;
  const update = {};
  if (enabled !== undefined) update["dmMessages.enabled"] = !!enabled;
  if (greeting !== undefined) update["dmMessages.greeting"] = greeting;
  if (followUp1 !== undefined) update["dmMessages.followUp1"] = followUp1;
  if (followUp2 !== undefined) update["dmMessages.followUp2"] = followUp2;
  if (followUp3 !== undefined) update["dmMessages.followUp3"] = followUp3;
  if (followUpIntervalHours !== undefined)
    update["dmMessages.followUpIntervalHours"] = followUpIntervalHours;

  const workspace = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    { $set: update },
    { new: true },
  );
  res.json({ success: true, dmMessages: workspace.dmMessages });
});

// @PUT /api/workspaces/:workspaceId/automation-settings — Save timing settings
const saveAutomationSettings = asyncHandler(async (req, res) => {
  const { minDelayMinutes, maxDelayMinutes, automationEnabled } = req.body;
  const update = {};
  if (minDelayMinutes !== undefined)
    update["settings.minDelayMinutes"] = minDelayMinutes;
  if (maxDelayMinutes !== undefined)
    update["settings.maxDelayMinutes"] = maxDelayMinutes;
  if (automationEnabled !== undefined)
    update["settings.automationEnabled"] = automationEnabled;

  const workspace = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    { $set: update },
    { new: true },
  );
  res.json({ success: true, settings: workspace.settings });
});

// ── GET keyword triggers ──────────────────────────────────────────────────────
const getKeywordTriggers = asyncHandler(async (req, res) => {
  const workspace = await Workspace.findById(req.workspace._id).select(
    "keywordTriggers",
  );
  res.json({ keywordTriggers: workspace.keywordTriggers || [] });
});

// ── PUT keyword triggers (replace all) ───────────────────────────────────────
const saveKeywordTriggers = asyncHandler(async (req, res) => {
  const { keywordTriggers } = req.body;
  if (!Array.isArray(keywordTriggers)) {
    return res.status(400).json({ error: "keywordTriggers must be an array" });
  }
  for (const t of keywordTriggers) {
    if (!t.keyword?.trim())
      return res.status(400).json({ error: "Each trigger needs a keyword" });
    if (!t.replyMessage?.trim())
      return res
        .status(400)
        .json({ error: "Each trigger needs a replyMessage" });
  }
  const workspace = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    { $set: { keywordTriggers } },
    { new: true },
  );
  res.json({ success: true, keywordTriggers: workspace.keywordTriggers });
});

// ── Generic getter/setter for any single-field trigger config ─────────────────
const getTriggerField = (fieldName) =>
  asyncHandler(async (req, res) => {
    const ws = await Workspace.findById(req.workspace._id).select(fieldName);
    res.json({ [fieldName]: ws?.[fieldName] ?? null });
  });

const setTriggerField = (fieldName) =>
  asyncHandler(async (req, res) => {
    // Accept either {fieldName: value} or raw value as the whole body
    const value =
      req.body && req.body[fieldName] !== undefined
        ? req.body[fieldName]
        : req.body;
    if (value === undefined || value === null) {
      return res.status(400).json({ error: `${fieldName} is required` });
    }
    const ws = await Workspace.findByIdAndUpdate(
      req.workspace._id,
      { $set: { [fieldName]: value } },
      { new: true },
    );
    res.json({ success: true, [fieldName]: ws[fieldName] });
  });

// DM keyword triggers
const getDmKeywordTriggers = getTriggerField("dmKeywordTriggers");
const saveDmKeywordTriggers = asyncHandler(async (req, res) => {
  const { dmKeywordTriggers } = req.body;
  if (!Array.isArray(dmKeywordTriggers))
    return res
      .status(400)
      .json({ error: "dmKeywordTriggers must be an array" });
  const ws = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    { $set: { dmKeywordTriggers } },
    { new: true },
  );
  res.json({ success: true, dmKeywordTriggers: ws.dmKeywordTriggers });
});

// Story reply / mention / share / live comment / ref urls / starters
const getStoryReplyTrigger = getTriggerField("storyReplyTrigger");
const setStoryReplyTrigger = setTriggerField("storyReplyTrigger");
const getStoryMentionTrigger = getTriggerField("storyMentionTrigger");
const setStoryMentionTrigger = setTriggerField("storyMentionTrigger");
const getShareToStoryTrigger = getTriggerField("shareToStoryTrigger");
const setShareToStoryTrigger = setTriggerField("shareToStoryTrigger");
const getLiveCommentTriggers = getTriggerField("liveCommentTriggers");
const setLiveCommentTriggers = setTriggerField("liveCommentTriggers");
const getRefUrlTriggers = getTriggerField("refUrlTriggers");
const setRefUrlTriggers = setTriggerField("refUrlTriggers");
const getConversationStarters = getTriggerField("conversationStarters");
const setConversationStarters = setTriggerField("conversationStarters");
const getFallbackReply = getTriggerField("fallbackReply");
const setFallbackReply = setTriggerField("fallbackReply");
const getAwayReply = getTriggerField("awayReply");
const setAwayReply = setTriggerField("awayReply");

// Business hours (per-day schedule + timezone)
const getBusinessHours = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select(
    "businessHours timezone settings.businessHoursEnabled",
  );
  res.json({
    enabled: ws?.settings?.businessHoursEnabled ?? false,
    timezone: ws?.timezone || "Asia/Karachi",
    schedule: ws?.businessHours || [],
  });
});
const setBusinessHours = asyncHandler(async (req, res) => {
  const { enabled, timezone, schedule } = req.body || {};
  const update = {};
  if (enabled !== undefined)
    update["settings.businessHoursEnabled"] = !!enabled;
  if (timezone !== undefined) update.timezone = String(timezone);
  if (Array.isArray(schedule)) update.businessHours = schedule;
  const ws = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    { $set: update },
    { new: true },
  );
  res.json({
    success: true,
    enabled: ws?.settings?.businessHoursEnabled ?? false,
    timezone: ws.timezone,
    schedule: ws.businessHours,
  });
});

// AI Bot config (Scale plan only — gated at route level)
const getAiBotConfig = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select("aiBot");
  res.json({ aiBot: ws?.aiBot ?? null });
});
const saveAiBotConfig = asyncHandler(async (req, res) => {
  const { aiBot } = req.body;
  if (!aiBot) return res.status(400).json({ error: "aiBot is required" });
  const ws = await Workspace.findByIdAndUpdate(
    req.workspace._id,
    { $set: { aiBot } },
    { new: true },
  );
  res.json({ success: true, aiBot: ws.aiBot });
});

// All trigger/bot config in one shot (used by Automation page)
const getAutomationConfig = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select(
    "keywordTriggers dmKeywordTriggers storyReplyTrigger storyMentionTrigger shareToStoryTrigger liveCommentTriggers refUrlTriggers conversationStarters fallbackReply awayReply aiBot dmMessages settings subscription businessHours timezone",
  );
  res.json({
    keywordTriggers: ws.keywordTriggers || [],
    dmKeywordTriggers: ws.dmKeywordTriggers || [],
    storyReplyTrigger: ws.storyReplyTrigger || { enabled: false },
    storyMentionTrigger: ws.storyMentionTrigger || { enabled: false },
    shareToStoryTrigger: ws.shareToStoryTrigger || { enabled: false },
    liveCommentTriggers: ws.liveCommentTriggers || [],
    refUrlTriggers: ws.refUrlTriggers || [],
    conversationStarters: ws.conversationStarters || {
      enabled: false,
      options: [],
    },
    fallbackReply: ws.fallbackReply || { enabled: true },
    awayReply: ws.awayReply || { enabled: false },
    aiBot: ws.aiBot || { enabled: false },
    dmMessages: ws.dmMessages || {},
    settings: ws.settings || {},
    subscription: ws.subscription || {},
    // businessHours as composite object so frontend can read .enabled, .timezone, .schedule
    businessHours: {
      enabled: ws?.settings?.businessHoursEnabled ?? false,
      timezone: ws?.timezone || "Asia/Karachi",
      schedule: Array.isArray(ws?.businessHours) ? ws.businessHours : [],
    },
  });
});

// @PATCH /api/workspaces/:workspaceId/activation — toggle activation step
const updateActivation = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const ws = await Workspace.findById(req.workspace._id);
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const allowed = [
    "welcomeSet",
    "keywordsSet",
    "contactsImported",
    "testSent",
    "dismissed",
  ];
  ws.activation = ws.activation || {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) ws.activation[key] = !!req.body[key];
  }
  await ws.save();
  res.json({ success: true, activation: ws.activation });
});

// @PUT /api/workspaces/:workspaceId/ai-knowledge — paste FAQ text
const updateAiKnowledge = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const ws = await Workspace.findById(req.workspace._id);
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const { content, enabled } = req.body || {};
  ws.aiKnowledge = ws.aiKnowledge || {};
  if (typeof content === "string") {
    ws.aiKnowledge.content = content.slice(0, 8000);
    ws.aiKnowledge.lastUpdatedAt = new Date();
  }
  if (typeof enabled === "boolean") ws.aiKnowledge.enabled = enabled;
  await ws.save();
  res.json({ success: true, aiKnowledge: ws.aiKnowledge });
});

// @PUT /api/workspaces/:workspaceId/smart-orders — catalog + payment instructions
const updateSmartOrders = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const ws = await Workspace.findById(req.workspace._id);
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const { enabled, catalog, paymentInstructions, notifyPhone } = req.body || {};
  ws.smartOrders = ws.smartOrders || {};
  if (typeof enabled === "boolean") ws.smartOrders.enabled = enabled;
  if (typeof catalog === "string") {
    ws.smartOrders.catalog = catalog.slice(0, 5000);
  }
  if (typeof paymentInstructions === "string") {
    ws.smartOrders.paymentInstructions = paymentInstructions.slice(0, 1000);
  }
  if (typeof notifyPhone === "string") {
    ws.smartOrders.notifyPhone = notifyPhone.trim().slice(0, 32);
  }
  ws.smartOrders.lastUpdatedAt = new Date();
  await ws.save();
  res.json({ success: true, smartOrders: ws.smartOrders });
});

module.exports = {
  createWorkspace,
  getWorkspaces,
  getWorkspace,
  updateWorkspace,
  updateActivation,
  updateAiKnowledge,
  updateSmartOrders,
  saveDmMessages,
  saveAutomationSettings,
  getKeywordTriggers,
  saveKeywordTriggers,
  getDmKeywordTriggers,
  saveDmKeywordTriggers,
  getStoryReplyTrigger,
  setStoryReplyTrigger,
  getStoryMentionTrigger,
  setStoryMentionTrigger,
  getShareToStoryTrigger,
  setShareToStoryTrigger,
  getLiveCommentTriggers,
  setLiveCommentTriggers,
  getRefUrlTriggers,
  setRefUrlTriggers,
  getConversationStarters,
  setConversationStarters,
  getFallbackReply,
  setFallbackReply,
  getAwayReply,
  setAwayReply,
  getBusinessHours,
  setBusinessHours,
  getAiBotConfig,
  saveAiBotConfig,
  getAutomationConfig,
  inviteMember,
  removeMember,
  completeOnboarding,
  updateOnboardingStep,
};
