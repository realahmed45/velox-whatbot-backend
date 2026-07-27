/**
 * Admin auth — a lightweight, self-contained gate for the Botlify admin panel.
 *
 * The admin is NOT a normal User row. Login checks a single email+password pair
 * from env (ADMIN_EMAIL / ADMIN_PASSWORD) and issues a short-lived JWT signed
 * with the app's JWT_SECRET but carrying an `admin: true` claim. This middleware
 * verifies that claim. No secret is ever committed to source.
 */
const jwt = require("jsonwebtoken");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const isAdminConfigured = () => !!(ADMIN_EMAIL && ADMIN_PASSWORD);

// Issue an admin token (8h). Only call after verifying credentials.
const signAdminToken = () =>
  jwt.sign({ admin: true, email: ADMIN_EMAIL }, process.env.JWT_SECRET, {
    expiresIn: "8h",
  });

// Constant-time-ish credential check against the env pair.
const checkAdminCredentials = (email, password) =>
  isAdminConfigured() &&
  String(email || "").toLowerCase().trim() === ADMIN_EMAIL &&
  String(password || "") === ADMIN_PASSWORD;

// Middleware: require a valid admin token on the Authorization header.
const requireAdmin = (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ message: "Admin authentication required" });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.admin) {
      return res.status(403).json({ message: "Not an admin token" });
    }
    req.admin = { email: decoded.email };
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired admin session" });
  }
};

module.exports = {
  isAdminConfigured,
  signAdminToken,
  checkAdminCredentials,
  requireAdmin,
  ADMIN_EMAIL,
};
