const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const User = require("../models/User");
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require("../utils/jwt");
const { generateToken, hashToken } = require("../utils/crypto");
const { validatePassword } = require("../utils/passwordPolicy");
const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendSignupNotification,
} = require("../services/emailService");

// A new user's 1-based join order, computed right before User.create from the
// current user count. Purely informational (shown in the admin panel).
const nextSignupNumber = async () => (await User.countDocuments()) + 1;

// Fire-and-forget: email the admin that a new user just joined. Never blocks or
// fails signup.
const notifyAdminOfSignup = (user, method) => {
  sendSignupNotification({
    name: user.name,
    email: user.email,
    method,
    signupNumber: user.signupNumber,
  }).catch((err) =>
    logger.error("[signup] admin notification failed", { err: err.message }),
  );
  // Activity log for the admin timeline.
  const { record, EVENTS } = require("../services/adminEvents");
  record(EVENTS.SIGNUP, {
    userId: user._id,
    userEmail: user.email,
    userName: user.name,
    message: `${user.name || user.email} signed up (${method})`,
    meta: { method, signupNumber: user.signupNumber },
  });
};

// Generate a random 4-digit verification code as a string ("0000"–"9999").
const generateVerificationCode = () =>
  String(Math.floor(1000 + Math.random() * 9000));
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
  const pwCheck = validatePassword(password, { email, name });
  if (!pwCheck.ok) {
    res.status(400);
    throw new Error(pwCheck.message);
  }

  const existing = await User.findOne({ email });
  if (existing) {
    res.status(409);
    throw new Error("Email already registered");
  }

  // Email/password signups must verify via a 4-digit code emailed to them.
  // NOTE: We create the ACCOUNT only — no workspace. A workspace is created
  // later, deliberately, during onboarding (or never, if this person only ever
  // joins someone else's workspace as an agent). Any referral code is stashed
  // on the user and applied when they create their first workspace.
  const verificationCode = generateVerificationCode();
  const signupNumber = await nextSignupNumber();
  const user = await User.create({
    name,
    email,
    password,
    isEmailVerified: false,
    emailVerificationToken: hashToken(verificationCode),
    emailVerificationExpires: Date.now() + 15 * 60 * 1000, // 15 minutes
    pendingRef: ref ? String(ref).toUpperCase().trim() : undefined,
    signupNumber,
    // Remember what they typed as their business name for the onboarding step.
    ...(businessName ? {} : {}),
  });
  notifyAdminOfSignup(user, "email");

  // Send the verification code (best-effort — failure shouldn't block signup;
  // the user can request a resend from the verify screen).
  await sendVerificationEmail({ to: user.email, name: user.name, code: verificationCode }).catch(
    (err) => logger.error("[register] verification email failed", { err: err.message }),
  );

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
// Emails a 4-digit reset code (same UX as signup verification). We store the
// HASH of the code in passwordResetToken so the plaintext never touches the DB.
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  // Always return success to prevent email enumeration.
  if (user) {
    const code = generateVerificationCode(); // 4-digit
    user.passwordResetToken = hashToken(code);
    user.passwordResetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    await user.save();

    await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      code,
    }).catch((err) =>
      logger.error("[forgotPassword] email failed", { err: err.message }),
    );
  }

  res.json({
    success: true,
    message: "If that email is registered, a reset code has been sent.",
  });
});

// @POST /api/auth/verify-reset-code
// Optional pre-check so the UI can confirm the code before asking for the new
// password. Enumeration-safe on the "no user" path.
const verifyResetCode = asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    res.status(400);
    throw new Error("Email and code are required");
  }
  const user = await User.findOne({ email }).select(
    "+passwordResetToken +passwordResetExpires",
  );
  const valid =
    user &&
    user.passwordResetToken &&
    user.passwordResetExpires &&
    user.passwordResetExpires.getTime() > Date.now() &&
    hashToken(String(code).trim()) === user.passwordResetToken;

  if (!valid) {
    res.status(400);
    throw new Error("Invalid or expired code");
  }
  res.json({ success: true, message: "Code verified" });
});

// @POST /api/auth/reset-password
// Accepts { email, code, password } (4-digit code flow). Falls back to the
// legacy { token, password } link flow if a token is supplied instead.
const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, token, password } = req.body;
  if (!password || (!code && !token)) {
    res.status(400);
    throw new Error("Code and new password are required");
  }
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) {
    res.status(400);
    throw new Error(pwCheck.message);
  }

  // The stored value is hashToken(code) for the code flow, or hashToken(token)
  // for the legacy link flow — both compare the same way.
  const provided = code ? String(code).trim() : token;
  const hashedProvided = hashToken(provided);

  const query = {
    passwordResetToken: hashedProvided,
    passwordResetExpires: { $gt: Date.now() },
  };
  // Scope by email when we have it (code flow) — harmless for the token flow.
  if (email) query.email = String(email).toLowerCase();

  const user = await User.findOne(query).select(
    "+passwordResetToken +passwordResetExpires",
  );

  if (!user) {
    res.status(400);
    throw new Error("Invalid or expired code");
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

// @POST /api/auth/verify-email
// Confirms the 4-digit code emailed at signup and marks the account verified.
const verifyEmailCode = asyncHandler(async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    res.status(400);
    throw new Error("Email and verification code are required");
  }

  const user = await User.findOne({ email }).select(
    "+emailVerificationToken +emailVerificationExpires",
  );
  if (!user) {
    res.status(404);
    throw new Error("Account not found");
  }
  if (user.isEmailVerified) {
    return res.json({ success: true, message: "Email already verified", user });
  }
  if (
    !user.emailVerificationToken ||
    !user.emailVerificationExpires ||
    user.emailVerificationExpires.getTime() < Date.now()
  ) {
    res.status(400);
    throw new Error("Code expired. Please request a new one.");
  }
  if (hashToken(String(code).trim()) !== user.emailVerificationToken) {
    res.status(400);
    throw new Error("Invalid verification code");
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  res.json({ success: true, message: "Email verified successfully", user });
});

// @POST /api/auth/resend-verification
// Issues a fresh 4-digit code. Enumeration-safe: always returns success.
const resendVerificationCode = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  if (user && !user.isEmailVerified) {
    const verificationCode = generateVerificationCode();
    user.emailVerificationToken = hashToken(verificationCode);
    user.emailVerificationExpires = Date.now() + 15 * 60 * 1000;
    await user.save();
    await sendVerificationEmail({
      to: user.email,
      name: user.name,
      code: verificationCode,
    }).catch((err) =>
      logger.error("[resendVerification] email failed", { err: err.message }),
    );
  }

  res.json({
    success: true,
    message: "If that account exists and is unverified, a new code has been sent.",
  });
});

// @GET /api/auth/me
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
    .select("+password")
    .populate("activeWorkspace", "name industry subscription usage instagram")
    // Populate the workspace LIST too so the account switcher / picker can show
    // real names + IG handles + plan badges (was raw ObjectIds before).
    .populate(
      "workspaces",
      "name logo industry subscription instagram verticalConfigured",
    );
  const obj = user.toJSON();
  // Tell the client whether a password is set (Google-only accounts have none),
  // so the Security settings can offer "Set password" vs "Change password".
  obj.hasPassword = !!user.password;
  obj.hasGoogle = !!user.googleId;
  res.json({ success: true, user: obj });
});

// @PUT /api/auth/password — change password (requires current password)
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword) {
    res.status(400);
    throw new Error("New password is required");
  }

  const user = await User.findById(req.user._id).select("+password");
  if (!user) {
    res.status(404);
    throw new Error("Account not found");
  }

  // Security check: verify the current password before allowing a change.
  if (user.password) {
    if (!currentPassword) {
      res.status(400);
      throw new Error("Enter your current password to change it.");
    }
    const match = await user.comparePassword(currentPassword);
    if (!match) {
      res.status(401);
      throw new Error("Current password is incorrect.");
    }
  }

  const pwCheck = validatePassword(newPassword, {
    email: user.email,
    name: user.name,
  });
  if (!pwCheck.ok) {
    res.status(400);
    throw new Error(pwCheck.message);
  }

  // Reject "changing" to the same password.
  if (user.password && (await user.comparePassword(newPassword))) {
    res.status(400);
    throw new Error("New password must be different from the current one.");
  }

  user.password = newPassword;
  await user.save();

  res.json({ success: true, message: "Password updated successfully." });
});

// @POST /api/auth/set-password — first-time password for Google-only accounts.
// No current password exists, so we gate on the authenticated + verified session.
const setPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body;
  const user = await User.findById(req.user._id).select("+password");
  if (!user) {
    res.status(404);
    throw new Error("Account not found");
  }
  if (user.password) {
    res.status(400);
    throw new Error(
      "You already have a password. Use change password instead.",
    );
  }
  const pwCheck = validatePassword(newPassword, {
    email: user.email,
    name: user.name,
  });
  if (!pwCheck.ok) {
    res.status(400);
    throw new Error(pwCheck.message);
  }

  user.password = newPassword;
  await user.save();

  res.json({
    success: true,
    message: "Password set. You can now sign in with your email and password.",
  });
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
    // Account only — no workspace. It's created deliberately at onboarding, or
    // never for someone who only joins another workspace as an agent. Stash any
    // referral code to apply when they create their first workspace.
    const signupNumber = await nextSignupNumber();
    user = await User.create({
      googleId,
      email,
      name,
      avatar,
      isEmailVerified: true, // Google-verified emails are trusted
      pendingRef: ref ? String(ref).toUpperCase().trim() : undefined,
      signupNumber,
    });
    notifyAdminOfSignup(user, "google");
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
  verifyResetCode,
  resetPassword,
  verifyEmailCode,
  resendVerificationCode,
  getMe,
  googleAuth,
  changePassword,
  setPassword,
};
