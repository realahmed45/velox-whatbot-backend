const crypto = require("crypto");

/**
 * Generate a secure random token (hex string)
 */
const generateToken = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString("hex");
};

/**
 * Hash a token for safe storage
 */
const hashToken = (token) => {
  return crypto.createHash("sha256").update(token).digest("hex");
};

/**
 * Generate HMAC-SHA256 signature (used by JazzCash)
 */
const hmacSHA256 = (data, key) => {
  return crypto
    .createHmac("sha256", key)
    .update(data)
    .digest("hex")
    .toUpperCase();
};

/**
 * Sort object keys alphabetically and concatenate values (JazzCash hash requirement)
 */
const buildJazzCashHash = (params, integrityKey) => {
  const sortedKeys = Object.keys(params).sort();
  const hashString = integrityKey + sortedKeys.map((k) => params[k]).join("&");
  return hmacSHA256(hashString, integrityKey);
};

module.exports = { generateToken, hashToken, hmacSHA256, buildJazzCashHash };
