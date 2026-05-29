const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const User = require("../models/User");
const Workspace = require("../models/Workspace");
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require("../utils/jwt");
const { generateToken, hashToken } = require("../utils/crypto");
const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
} = require("../services/emailService");
const logger = require("../utils/logger");
const { OAuth2Client } = require("google-auth-library");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// @POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { name, email, password, businessName, ref } = req.body;

  if (!name || !email || !password) {
    res.status(400);
    throw new Error("Name, email, and password are required");
  }
  if (password.length < 8) {
    res.status(400);
    throw new Error("Password must be at least 8 characters");
  }

  const existing = await User.findOne({ email });
  if (existing) {
    res.status(409);
    throw new Error("Email already registered");
  }

  const user = await User.create({
    name,
    email,
    password,
    isEmailVerified: true,
  });

  // Auto-create workspace so user lands directly on dashboard
  const workspace = await Workspace.create({
    name: businessName || `${name}'s Workspace`,
    owner: user._id,
    members: [{ user: user._id, role: "owner" }],
    industry: "other",
  });

  // Referral tracking (G8): if a ref code was provided, link the new workspace
  // to the referrer and bump their signup counter.
  if (ref) {
    const refCode = String(ref).toUpperCase().trim();
    const referrer = await Workspace.findOne({ "referral.code": refCode });
    if (referrer && String(referrer._id) !== String(workspace._id)) {
      workspace.referral.referredBy = referrer._id;
      await workspace.save();
      await Workspace.updateOne(
        { _id: referrer._id },
        { $inc: { "referral.signups": 1 } },
      );
    }
  }

  user.workspaces = [workspace._id];
  user.activeWorkspace = workspace._id;
  await user.save();

  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  res.status(201).json({
    success: true,
    message: "Account created successfully.",
    token: accessToken,
    refreshToken,
    user,
  });
});

// @POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400);
    throw new Error("Email and password required");
  }

  const user = await User.findOne({ email }).select("+password");
  if (!user || !(await user.comparePassword(password))) {
    res.status(401);
    throw new Error("Invalid email or password");
  }

  // Ensure legacy unverified users can still log in

  user.lastLogin = new Date();
  await user.save();

  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  res.json({
    success: true,
    token: accessToken,
    refreshToken,
    user,
  });
});

// @POST /api/auth/refresh
const refreshToken = asyncHandler(async (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) {
    res.status(400);
    throw new Error("Refresh token required");
  }

  try {
    const decoded = verifyRefreshToken(token);
    const user = await User.findById(decoded.id);
    if (!user) {
      res.status(401);
      throw new Error("User not found");
    }

    const newAccessToken = generateAccessToken(user._id);
    res.json({ success: true, token: newAccessToken });
  } catch {
    res.status(401);
    throw new Error("Invalid or expired refresh token");
  }
});

// @POST /api/auth/forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  // Always return success to prevent email enumeration
  if (user) {
    const resetToken = generateToken();
    user.passwordResetToken = hashToken(resetToken);
    user.passwordResetExpires = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save();

    const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`;
    await sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl });
  }

  res.json({
    success: true,
    message: "If that email is registered, a reset link has been sent.",
  });
});

// @POST /api/auth/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    res.status(400);
    throw new Error("Token and new password required");
  }
  if (password.length < 8) {
    res.status(400);
    throw new Error("Password must be at least 8 characters");
  }

  const hashedToken = hashToken(token);
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  }).select("+passwordResetToken +passwordResetExpires");

  if (!user) {
    res.status(400);
    throw new Error("Invalid or expired reset token");
  }

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  res.json({
    success: true,
    message: "Password reset successfully. You can now log in.",
  });
});

// @GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate(
    "activeWorkspace",
    "name industry subscription usage instagram",
  );
  res.json({ success: true, user });
});

// @POST /api/auth/google
// Receives the raw Google ID token (credential) from the client and verifies
// it server-side against our GOOGLE_CLIENT_ID. We NEVER trust client-supplied
// email/id — that would allow trivial account takeover.
const googleAuth = asyncHandler(async (req, res) => {
  const { credential, ref } = req.body;
  if (!credential) {
    res.status(400);
    throw new Error("Google credential required");
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    logger.error("[googleAuth] GOOGLE_CLIENT_ID not configured");
    res.status(500);
    throw new Error("Google sign-in is not configured");
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn("[googleAuth] token verification failed", {
      err: err.message,
    });
    res.status(401);
    throw new Error("Invalid or expired Google credential");
  }

  if (!payload?.email || !payload.email_verified) {
    res.status(401);
    throw new Error("Google account email is not verified");
  }

  const googleId = payload.sub;
  const email = payload.email.toLowerCase();
  const name = payload.name || email.split("@")[0];
  const avatar = payload.picture;

  let user = await User.findOne({ $or: [{ googleId }, { email }] });
  let isNew = false;

  if (!user) {
    isNew = true;
    user = await User.create({
      googleId,
      email,
      name,
      avatar,
      isEmailVerified: true, // Google-verified emails are trusted
    });

    // Auto-create a workspace so the new user lands in onboarding cleanly.
    const workspace = await Workspace.create({
      name: `${name}'s Workspace`,
      owner: user._id,
      members: [{ user: user._id, role: "owner" }],
      industry: "other",
    });

    if (ref) {
      const refCode = String(ref).toUpperCase().trim();
      const referrer = await Workspace.findOne({ "referral.code": refCode });
      if (referrer && String(referrer._id) !== String(workspace._id)) {
        workspace.referral.referredBy = referrer._id;
        await workspace.save();
        await Workspace.updateOne(
          { _id: referrer._id },
          { $inc: { "referral.signups": 1 } },
        );
      }
    }

    user.workspaces = [workspace._id];
    user.activeWorkspace = workspace._id;
    await user.save();

    await sendWelcomeEmail({ to: email, name }).catch(() => {});
  } else if (!user.googleId) {
    // Link Google to an existing email/password account.
    user.googleId = googleId;
    user.isEmailVerified = true;
    if (!user.avatar && avatar) user.avatar = avatar;
  }

  user.lastLogin = new Date();
  await user.save();

  const accessToken = generateAccessToken(user._id);
  const refreshTokenValue = generateRefreshToken(user._id);

  res.json({
    success: true,
    isNew,
    token: accessToken,
    refreshToken: refreshTokenValue,
    user,
  });
});

module.exports = {
  register,
  login,
  refreshToken,
  forgotPassword,
  resetPassword,
  getMe,
  googleAuth,
};
