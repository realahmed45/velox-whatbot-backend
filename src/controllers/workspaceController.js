const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const User = require("../models/User");
const { encrypt, decrypt } = require("../utils/encryption");
const { sendTeamInviteEmail } = require("../services/emailService");
const { generateToken, hashToken } = require("../utils/crypto");
const { generateAccessToken, generateRefreshToken } = require("../utils/jwt");
const { validatePassword } = require("../utils/passwordPolicy");
const {
  PERMISSION_LIST,
  DEFAULT_AGENT_PERMISSIONS,
  sanitizePermissions,
} = require("../config/permissions");
const logger = require("../utils/logger");

const DEFAULT_BUSINESS_HOURS = [
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

/**
 * Apply a user's stashed referral code (captured at signup) to a freshly
 * created workspace, then clear it so it's only ever used once. Best-effort:
 * a bad/unknown code just no-ops.
 */
async function applyPendingReferral(userId, workspace) {
  const u = await User.findById(userId).select("+pendingRef");
  const code = u?.pendingRef;
  if (!code) return;
  try {
    const referrer = await Workspace.findOne({ "referral.code": code });
    if (referrer && String(referrer._id) !== String(workspace._id)) {
      workspace.referral.referredBy = referrer._id;
      await workspace.save();
      await Workspace.updateOne(
        { _id: referrer._id },
        { $inc: { "referral.signups": 1 } },
      );
    }
  } catch (err) {
    logger.warn("[referral] apply failed", { err: err.message });
  }
  u.pendingRef = undefined;
  await u.save();
}

/**
 * Create a workspace OWNED by `user` and switch them into it. Adds the owner as
 * a member[] too so permission checks and the Team page stay consistent.
 */
async function createOwnedWorkspace(user, { name, industry, logo, timezone }) {
  const workspace = await Workspace.create({
    name,
    industry: industry || "other",
    logo,
    businessHours: DEFAULT_BUSINESS_HOURS,
    timezone: timezone || "Asia/Karachi",
    owner: user._id,
    members: [{ user: user._id, role: "owner" }],
  });
  await User.findByIdAndUpdate(user._id, {
    $addToSet: { workspaces: workspace._id },
    activeWorkspace: workspace._id,
  });
  await applyPendingReferral(user._id, workspace);
  return workspace;
}

// @POST /api/workspaces — Create workspace (deliberate, during onboarding)
const createWorkspace = asyncHandler(async (req, res) => {
  const { name, industry: industryField, businessType, logo, timezone } =
    req.body;
  const industry = industryField || businessType;
  if (!name) {
    res.status(400);
    throw new Error("Workspace name is required");
  }

  const workspace = await createOwnedWorkspace(req.user, {
    name,
    industry,
    logo,
    timezone,
  });

  res.status(201).json({ success: true, workspace });
});

// @POST /api/workspaces/ensure — idempotent: return the user's owned workspace,
// creating a default one if they don't have any yet. Called at the start of
// onboarding so the flow always has a workspace to attach Instagram to, WITHOUT
// creating one at signup (agents who only join others never hit this).
const ensureOwnWorkspace = asyncHandler(async (req, res) => {
  let workspace = await Workspace.findOne({ owner: req.user._id });
  let created = false;
  if (!workspace) {
    workspace = await createOwnedWorkspace(req.user, {
      name: (req.body?.name || "").trim() || `${req.user.name}'s Workspace`,
      industry: req.body?.industry,
    });
    created = true;
  } else if (
    String(req.user.activeWorkspace || "") !== String(workspace._id)
  ) {
    // Make sure it's their active workspace.
    await User.findByIdAndUpdate(req.user._id, {
      activeWorkspace: workspace._id,
    });
  }
  res.status(created ? 201 : 200).json({ success: true, workspace, created });
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
  // Populate people so the Team page can show names/emails/avatars instead of
  // raw ids (the requireWorkspace middleware loads the doc without populating).
  await req.workspace.populate([
    { path: "owner", select: "name email avatar" },
    { path: "members.user", select: "name email avatar" },
  ]);
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
  const { email, role = "agent", permissions } = req.body;
  if (!email) {
    res.status(400);
    throw new Error("Email required");
  }
  const grantedPermissions =
    sanitizePermissions(permissions).length > 0
      ? sanitizePermissions(permissions)
      : DEFAULT_AGENT_PERMISSIONS;

  const workspace = req.workspace;
  const normEmail = String(email).toLowerCase().trim();
  const inviteToken = generateToken();

  // Check if already a member
  const existingUser = await User.findOne({ email: normEmail });
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

  // Persist a pending invite (replacing any prior one for the same email) so
  // the emailed link can actually be accepted later.
  workspace.pendingInvites = (workspace.pendingInvites || []).filter(
    (i) => i.email !== normEmail,
  );
  workspace.pendingInvites.push({
    email: normEmail,
    role: role === "owner" ? "agent" : role, // never invite straight to owner
    permissions: grantedPermissions,
    tokenHash: hashToken(inviteToken),
    invitedBy: req.user._id,
    invitedAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  });
  await workspace.save();

  const inviteUrl = `${process.env.CLIENT_URL}/invite?token=${inviteToken}&workspace=${workspace._id}&email=${encodeURIComponent(normEmail)}`;
  await sendTeamInviteEmail({
    to: normEmail,
    inviterName: req.user.name,
    workspaceName: workspace.name,
    inviteUrl,
  }).catch(() => {});

  res.json({ success: true, message: `Invitation sent to ${normEmail}` });
});

// @GET /api/workspaces/permissions — the catalogue for the invite UI.
const getPermissionCatalogue = asyncHandler(async (req, res) => {
  res.json({ success: true, permissions: PERMISSION_LIST });
});

// @PUT /api/workspaces/:workspaceId/members/:userId/permissions (owner)
const updateMemberPermissions = asyncHandler(async (req, res) => {
  if (req.workspaceRole !== "owner") {
    res.status(403);
    throw new Error("Only owners can change permissions");
  }
  const member = req.workspace.members.find(
    (m) => String(m.user) === String(req.params.userId),
  );
  if (!member) {
    res.status(404);
    throw new Error("Member not found");
  }
  member.permissions = sanitizePermissions(req.body.permissions);
  await req.workspace.save();
  res.json({ success: true, permissions: member.permissions });
});

// @GET /api/workspaces/:workspaceId/invites — list outstanding invites (owner)
const listInvites = asyncHandler(async (req, res) => {
  const invites = (req.workspace.pendingInvites || []).map((i) => ({
    email: i.email,
    role: i.role,
    permissions: i.permissions || [],
    invitedAt: i.invitedAt,
    expiresAt: i.expiresAt,
    expired: i.expiresAt && i.expiresAt.getTime() < Date.now(),
  }));
  res.json({ success: true, invites });
});

// @DELETE /api/workspaces/:workspaceId/invites/:email — revoke an invite (owner)
const revokeInvite = asyncHandler(async (req, res) => {
  if (req.workspaceRole !== "owner") {
    res.status(403);
    throw new Error("Only owners can revoke invites");
  }
  const email = decodeURIComponent(req.params.email || "").toLowerCase();
  req.workspace.pendingInvites = (req.workspace.pendingInvites || []).filter(
    (i) => i.email !== email,
  );
  await req.workspace.save();
  res.json({ success: true, message: "Invite revoked" });
});

/**
 * Attach a user to a workspace as a joined member and switch them INTO it.
 *
 * Team members (agents) don't run their own onboarding — the owner already
 * connected Instagram. So we:
 *   1. add the workspace to the user's list (if missing),
 *   2. make it their active workspace,
 *   3. mark onboarding complete so RequireOnboarding never bounces them,
 *   4. clean up a throwaway personal workspace they never set up — i.e. one
 *      they own, that has no Instagram connected and no other members. This
 *      avoids the confusing "empty second workspace" that was sending Google
 *      invitees into onboarding.
 */
async function joinWorkspaceAsMember(user, workspaceId) {
  const wsId = workspaceId.toString();

  if (!user.workspaces?.some((w) => w.toString() === wsId)) {
    user.workspaces = [...(user.workspaces || []), workspaceId];
  }
  user.activeWorkspace = workspaceId;
  user.onboardingCompleted = true;

  // Remove any empty personal workspace the user owns (auto-created at signup)
  // so it can't hijack their active context or force onboarding.
  const owned = await Workspace.find({ owner: user._id });
  for (const w of owned) {
    if (w._id.toString() === wsId) continue;
    const noIg = w.instagram?.status !== "connected";
    const soloMember = (w.members || []).length <= 1;
    if (noIg && soloMember) {
      await Workspace.deleteOne({ _id: w._id });
      user.workspaces = (user.workspaces || []).filter(
        (id) => id.toString() !== w._id.toString(),
      );
    }
  }

  await user.save();
}

// @POST /api/workspaces/accept-invite — the invited (logged-in) user joins.
// Body: { token, workspaceId }. Requires auth (they must have an account).
const acceptInvite = asyncHandler(async (req, res) => {
  const { token, workspaceId } = req.body;
  if (!token || !workspaceId) {
    res.status(400);
    throw new Error("Invite token and workspace are required");
  }

  const Workspace = require("../models/Workspace");
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) {
    res.status(404);
    throw new Error("Workspace not found");
  }

  const th = hashToken(token);
  const invite = (workspace.pendingInvites || []).find(
    (i) => i.tokenHash === th,
  );
  if (!invite) {
    res.status(400);
    throw new Error("This invite is invalid or has already been used.");
  }
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    res.status(400);
    throw new Error("This invite has expired. Ask the owner to resend it.");
  }
  // The signed-in user's email must match the invited email.
  if (req.user.email.toLowerCase() !== invite.email) {
    res.status(403);
    throw new Error(
      `This invite was sent to ${invite.email}. Sign in with that email to accept.`,
    );
  }

  // Already a member? Just clear the invite.
  const already =
    workspace.owner.toString() === req.user._id.toString() ||
    workspace.members.some((m) => m.user.toString() === req.user._id.toString());
  if (!already) {
    workspace.members.push({
      user: req.user._id,
      role: invite.role || "agent",
      permissions: sanitizePermissions(invite.permissions),
      invitedAt: invite.invitedAt,
      joinedAt: new Date(),
    });
  }
  workspace.pendingInvites = workspace.pendingInvites.filter(
    (i) => i.tokenHash !== th,
  );
  await workspace.save();

  // Make the joined workspace the user's active one and switch them into the
  // team context. Agents never run their own onboarding — the owner already set
  // up Instagram, so we mark onboarding complete and drop them straight into the
  // owner's dashboard with their granted permissions.
  await joinWorkspaceAsMember(req.user, workspace._id);

  res.json({
    success: true,
    message: `You've joined ${workspace.name}!`,
    workspaceId: workspace._id,
  });
});

// @GET /api/workspaces/invite-info?token=&workspace= — public.
// Lets the Join screen show the workspace name + invited email (locked) without
// requiring the visitor to be signed in first.
const getInviteInfo = asyncHandler(async (req, res) => {
  const { token, workspace: workspaceId } = req.query;
  if (!token || !workspaceId) {
    res.status(400);
    throw new Error("Invite token and workspace are required");
  }
  const workspace = await Workspace.findById(workspaceId).populate(
    "owner",
    "name email",
  );
  if (!workspace) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const th = hashToken(token);
  const invite = (workspace.pendingInvites || []).find(
    (i) => i.tokenHash === th,
  );
  if (!invite) {
    res.status(400);
    throw new Error("This invite is invalid or has already been used.");
  }
  const expired = invite.expiresAt && invite.expiresAt.getTime() < Date.now();

  // Does an account already exist for the invited email? Drives whether the
  // Join screen shows "sign in" vs "create account".
  const existingUser = await User.exists({
    email: invite.email.toLowerCase(),
  });

  res.json({
    success: true,
    workspaceName: workspace.name,
    ownerName: workspace.owner?.name || null,
    email: invite.email,
    role: invite.role || "agent",
    expired,
    hasAccount: !!existingUser,
  });
});

// @POST /api/workspaces/invite-signup — public.
// Creates a brand-new account for the invited email AND joins the workspace in
// one step (or joins an existing verified account if the caller already has
// one — but that path normally goes through /accept-invite). Requires the
// standard password policy. Returns auth tokens so the client logs straight in.
const registerAndAcceptInvite = asyncHandler(async (req, res) => {
  const { token, workspaceId, name, password } = req.body;
  if (!token || !workspaceId || !name || !password) {
    res.status(400);
    throw new Error("Name, password, token and workspace are required");
  }

  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const th = hashToken(token);
  const invite = (workspace.pendingInvites || []).find(
    (i) => i.tokenHash === th,
  );
  if (!invite) {
    res.status(400);
    throw new Error("This invite is invalid or has already been used.");
  }
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    res.status(400);
    throw new Error("This invite has expired. Ask the owner to resend it.");
  }

  const email = invite.email.toLowerCase();

  // If an account already exists for this email, don't silently overwrite it —
  // send them to the login flow instead.
  const existing = await User.findOne({ email });
  if (existing) {
    res.status(409);
    throw new Error(
      "An account already exists for this email. Please sign in to accept the invite.",
    );
  }

  const pwCheck = validatePassword(password, { email, name });
  if (!pwCheck.ok) {
    res.status(400);
    throw new Error(pwCheck.message);
  }

  // Create the account. Invited emails are considered verified — the owner
  // vouched for them and the invite went to that inbox.
  const user = await User.create({
    name,
    email,
    password,
    isEmailVerified: true,
  });

  // Join the inviting workspace as a member with the granted permissions.
  workspace.members.push({
    user: user._id,
    role: invite.role || "agent",
    permissions: sanitizePermissions(invite.permissions),
    invitedAt: invite.invitedAt,
    joinedAt: new Date(),
  });
  workspace.pendingInvites = workspace.pendingInvites.filter(
    (i) => i.tokenHash !== th,
  );
  await workspace.save();

  // Switch the new user into the owner's workspace and skip onboarding.
  await joinWorkspaceAsMember(user, workspace._id);

  const accessToken = generateAccessToken(user._id);
  const refreshTokenValue = generateRefreshToken(user._id);

  res.status(201).json({
    success: true,
    message: `Welcome to ${workspace.name}!`,
    token: accessToken,
    refreshToken: refreshTokenValue,
    user,
    workspaceId: workspace._id,
  });
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
// Map the UI's short day keys to the schema's full names (both accepted).
const DAY_MAP = {
  mon: "monday",
  tue: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
};
const normalizeDay = (d) => {
  const s = String(d || "").toLowerCase();
  return DAY_MAP[s] || DAY_MAP[s.slice(0, 3)] || s;
};

const setBusinessHours = asyncHandler(async (req, res) => {
  const { enabled, timezone, schedule } = req.body || {};
  const update = {};
  if (enabled !== undefined)
    update["settings.businessHoursEnabled"] = !!enabled;
  if (timezone !== undefined) update.timezone = String(timezone);
  if (Array.isArray(schedule)) {
    update.businessHours = schedule.map((s) => ({
      ...s,
      day: normalizeDay(s.day),
      // Accept the UI's {start,end} too, mapping to schema's open/close.
      openTime: s.openTime || s.start || "09:00",
      closeTime: s.closeTime || s.end || "18:00",
      isOpen: s.isOpen !== undefined ? s.isOpen : s.enabled !== false,
    }));
  }
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
    ws.aiKnowledge.content = content.slice(0, 12000);
    ws.aiKnowledge.lastUpdatedAt = new Date();
  }
  if (typeof enabled === "boolean") ws.aiKnowledge.enabled = enabled;
  await ws.save();
  res.json({ success: true, aiKnowledge: ws.aiKnowledge });
});

// @POST /api/workspaces/:workspaceId/ai-knowledge/import-url
// Scrape a website (+ key internal pages), distill it with AI, and store it as
// a knowledge source the DM bot can use.
const importKnowledgeSource = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const { importWebsite } = require("../services/ai/websiteImporter");
  const ws = await Workspace.findById(req.workspace._id);
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }

  const { url } = req.body || {};
  if (!url || !String(url).trim()) {
    res.status(400);
    throw new Error("A website URL is required");
  }

  ws.aiKnowledge = ws.aiKnowledge || {};
  ws.aiKnowledge.sources = ws.aiKnowledge.sources || [];
  if (ws.aiKnowledge.sources.length >= 12) {
    res.status(400);
    throw new Error("You can keep up to 12 sources. Remove one first.");
  }

  let result;
  try {
    result = await importWebsite(url);
  } catch (err) {
    res.status(422);
    throw new Error(err.message || "Could not import that website");
  }

  ws.aiKnowledge.enabled = true;
  ws.aiKnowledge.sources.push({
    type: "website",
    label: result.title,
    url: result.url,
    content: result.content,
    status: "ready",
    charCount: result.charCount,
    addedAt: new Date(),
    syncedAt: new Date(),
  });
  ws.aiKnowledge.lastUpdatedAt = new Date();
  // Adding knowledge turns the bot live (Manychat-style — no separate toggle).
  ws.set("aiSettings.enabled", true);
  await ws.save();

  const source = ws.aiKnowledge.sources[ws.aiKnowledge.sources.length - 1];
  res.json({ success: true, source, pagesScraped: result.pagesScraped });
});

// @POST /api/workspaces/:workspaceId/ai-knowledge/import-doc  (multipart)
// Upload a PDF / text doc (menu, price list, policy) → distilled knowledge.
const importKnowledgeDocument = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const { importDocument } = require("../services/ai/websiteImporter");
  const ws = await Workspace.findById(req.workspace._id);
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  if (!req.file) {
    res.status(400);
    throw new Error("No file uploaded");
  }
  ws.aiKnowledge = ws.aiKnowledge || {};
  ws.aiKnowledge.sources = ws.aiKnowledge.sources || [];
  if (ws.aiKnowledge.sources.length >= 12) {
    res.status(400);
    throw new Error("You can keep up to 12 sources. Remove one first.");
  }

  let result;
  try {
    result = await importDocument(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );
  } catch (err) {
    res.status(422);
    throw new Error(err.message || "Could not read that file");
  }

  // If the upload is an image (menu, price list, lookbook), keep the actual
  // image so the AI bot can send it back to customers — not just its OCR text.
  const isImage = (req.file.mimetype || "").startsWith("image/");
  let imageUrl = "";
  if (isImage) {
    try {
      const cloudinary = require("../config/cloudinary");
      const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
      if (!cloudName) {
        logger.warn(
          "[knowledge] CLOUDINARY_CLOUD_NAME not set — image will save as text only",
        );
      }
      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const uploaded = await cloudinary.uploader.upload(dataUri, {
        folder: `botlify/knowledge/${ws._id}`,
        resource_type: "image",
      });
      imageUrl = uploaded.secure_url || "";
      logger.info(
        `[knowledge] image uploaded to Cloudinary: ${imageUrl.slice(0, 80)}`,
      );
    } catch (e) {
      logger.warn(`[knowledge] image upload failed: ${e.message}`);
    }
  }

  ws.aiKnowledge.enabled = true;
  ws.aiKnowledge.sources.push({
    type: imageUrl ? "image" : "text",
    label: result.title,
    url: "",
    imageUrl,
    content: result.content,
    status: "ready",
    charCount: result.charCount,
    addedAt: new Date(),
    syncedAt: new Date(),
  });
  ws.aiKnowledge.lastUpdatedAt = new Date();
  ws.set("aiSettings.enabled", true);
  await ws.save();
  res.json({
    success: true,
    source: ws.aiKnowledge.sources[ws.aiKnowledge.sources.length - 1],
  });
});

// @POST /api/workspaces/:workspaceId/ai-knowledge/sources/:sourceId/resync
// Re-fetch a website source (or Shopify) so the bot's knowledge stays fresh.
const resyncKnowledgeSource = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const ws = await Workspace.findById(req.workspace._id).select(
    "+integrations.shopify.accessToken",
  );
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const src = (ws.aiKnowledge?.sources || []).find(
    (s) => String(s._id) === String(req.params.sourceId),
  );
  if (!src) {
    res.status(404);
    throw new Error("Source not found");
  }

  try {
    if (src.type === "website" && src.url) {
      const { importWebsite } = require("../services/ai/websiteImporter");
      const r = await importWebsite(src.url);
      src.content = r.content;
      src.charCount = r.charCount;
      src.label = r.title || src.label;
    } else if (src.type === "shopify") {
      const shopify = require("../services/shopifyService");
      const { decrypt } = require("../utils/encryption");
      const s = ws.integrations?.shopify;
      if (!s?.storeUrl || !s?.accessToken) {
        res.status(400);
        throw new Error("Shopify is no longer connected");
      }
      const products = await shopify.listProducts(
        s.storeUrl,
        decrypt(s.accessToken),
        100,
      );
      const content =
        `Live Shopify catalog (${products.length} products):\n${products
          .map((p) => {
            const price = p.price
              ? `${p.currency || ""} ${p.price}`.trim()
              : "";
            const stock = p.inStock ? "" : " (out of stock)";
            return `- ${p.title}${price ? ` — ${price}` : ""}${stock} · ${p.url}`;
          })
          .join("\n")}`.slice(0, 16000);
      src.content = content;
      src.charCount = content.length;
    } else {
      res.status(400);
      throw new Error("This source can't be re-synced");
    }
  } catch (err) {
    res.status(422);
    throw new Error(err.message || "Re-sync failed");
  }

  src.status = "ready";
  src.syncedAt = new Date();
  ws.aiKnowledge.lastUpdatedAt = new Date();
  await ws.save();
  res.json({ success: true, source: src });
});

// @POST /api/workspaces/:workspaceId/ai-knowledge/sync-shopify
// Pull the live Shopify catalog and store it as a knowledge source so the bot
// can quote real products + prices. Replaces any previous Shopify source.
const syncShopifyKnowledge = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const shopify = require("../services/shopifyService");
  const { decrypt } = require("../utils/encryption");

  const ws = await Workspace.findById(req.workspace._id).select(
    "+integrations.shopify.accessToken",
  );
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const s = ws.integrations?.shopify;
  if (!s?.storeUrl) {
    res.status(400);
    throw new Error(
      "Connect your Shopify store first (Integrations → Shopify)",
    );
  }

  let products;
  try {
    // Storefront (tokenless) connections — use public REST with full pagination
    if (s.authMethod === "storefront" || !s.accessToken) {
      products = await shopify.listAllProductsStorefront(s.storeUrl, 1000);
    } else {
      products = await shopify.listProducts(
        s.storeUrl,
        decrypt(s.accessToken),
        250,
      );
    }
  } catch (err) {
    res.status(422);
    throw new Error(`Couldn't fetch Shopify products: ${err.message || ""}`);
  }
  if (!products.length) {
    res.status(422);
    throw new Error("No products found in your Shopify store");
  }

  const catalogLines = products.map((p) => {
    const price = p.price ? `${p.currency || ""} ${p.price}`.trim() : "";
    const stock = p.inStock ? "in stock" : "out of stock";
    const desc = p.description ? ` — ${p.description.slice(0, 150)}` : "";
    return `- ${p.title}${price ? ` | ${price}` : ""} | ${stock}${desc} | ${p.url}`;
  });
  const content =
    `Live Shopify catalog (${products.length} products):\n${catalogLines.join(
      "\n",
    )}`.slice(0, 50000);

  ws.aiKnowledge = ws.aiKnowledge || {};
  ws.aiKnowledge.sources = (ws.aiKnowledge.sources || []).filter(
    (x) => x.type !== "shopify",
  );
  ws.aiKnowledge.enabled = true;
  ws.aiKnowledge.sources.push({
    type: "shopify",
    label: `Shopify · ${s.storeUrl}`,
    url: `https://${s.storeUrl}`,
    content,
    status: "ready",
    charCount: content.length,
    addedAt: new Date(),
    syncedAt: new Date(),
  });
  ws.aiKnowledge.lastUpdatedAt = new Date();
  ws.set("aiSettings.enabled", true);
  await ws.save();

  const source = ws.aiKnowledge.sources[ws.aiKnowledge.sources.length - 1];
  res.json({ success: true, source, productCount: products.length });
});

// @DELETE /api/workspaces/:workspaceId/ai-knowledge/sources/:sourceId
const deleteKnowledgeSource = asyncHandler(async (req, res) => {
  const Workspace = require("../models/Workspace");
  const ws = await Workspace.findById(req.workspace._id);
  if (!ws) {
    res.status(404);
    throw new Error("Workspace not found");
  }
  const { sourceId } = req.params;
  ws.aiKnowledge = ws.aiKnowledge || {};
  ws.aiKnowledge.sources = (ws.aiKnowledge.sources || []).filter(
    (s) => String(s._id) !== String(sourceId),
  );
  ws.aiKnowledge.lastUpdatedAt = new Date();
  await ws.save();
  res.json({ success: true, sources: ws.aiKnowledge.sources });
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
  ensureOwnWorkspace,
  getWorkspaces,
  getWorkspace,
  updateWorkspace,
  updateActivation,
  updateAiKnowledge,
  importKnowledgeSource,
  importKnowledgeDocument,
  resyncKnowledgeSource,
  syncShopifyKnowledge,
  deleteKnowledgeSource,
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
  listInvites,
  revokeInvite,
  acceptInvite,
  getInviteInfo,
  registerAndAcceptInvite,
  getPermissionCatalogue,
  updateMemberPermissions,
  completeOnboarding,
  updateOnboardingStep,
};
