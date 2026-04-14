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
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
} = require("../services/emailService");

// @POST /api/auth/register
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

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

  const verificationToken = generateToken();
  const hashedToken = hashToken(verificationToken);

  const user = await User.create({
    name,
    email,
    password,
    emailVerificationToken: hashedToken,
    emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000, // 24h
  });

  const verificationUrl = `${process.env.CLIENT_URL}/verify-email?token=${verificationToken}`;
  await sendVerificationEmail({ to: email, name, verificationUrl });

  res.status(201).json({
    success: true,
    message:
      "Registration successful. Please check your email to verify your account.",
  });
});

// @POST /api/auth/verify-email
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) {
    res.status(400);
    throw new Error("Verification token required");
  }

  const hashedToken = hashToken(token);
  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: Date.now() },
  }).select("+emailVerificationToken +emailVerificationExpires");

  if (!user) {
    res.status(400);
    throw new Error("Invalid or expired verification token");
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  await sendWelcomeEmail({ to: user.email, name: user.name });

  const accessToken = generateAccessToken(user._id);
  res.json({
    success: true,
    message: "Email verified successfully",
    token: accessToken,
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

  if (!user.isEmailVerified) {
    res.status(403);
    throw new Error("Please verify your email address before logging in");
  }

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
    "name industry subscription usage whatsapp",
  );
  res.json({ success: true, user });
});

// @POST /api/auth/google
const googleAuth = asyncHandler(async (req, res) => {
  const { googleId, email, name, avatar } = req.body;
  if (!googleId || !email) {
    res.status(400);
    throw new Error("Google auth data required");
  }

  let user = await User.findOne({ $or: [{ googleId }, { email }] });

  if (!user) {
    user = await User.create({
      googleId,
      email,
      name,
      avatar,
      isEmailVerified: true, // Google-verified emails are trusted
    });
    await sendWelcomeEmail({ to: email, name });
  } else if (!user.googleId) {
    user.googleId = googleId;
    user.isEmailVerified = true;
    await user.save();
  }

  const accessToken = generateAccessToken(user._id);
  const refreshToken = generateRefreshToken(user._id);

  res.json({ success: true, token: accessToken, refreshToken, user });
});

module.exports = {
  register,
  verifyEmail,
  login,
  refreshToken,
  forgotPassword,
  resetPassword,
  getMe,
  googleAuth,
};
