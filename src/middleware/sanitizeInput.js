/**
 * Botlify — Input Sanitization Middleware
 * Prevents XSS attacks by sanitizing user inputs
 */
const { filterXSS } = require("xss");

/**
 * Sanitize all string fields in request body recursively
 */
const sanitizeObject = (obj) => {
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item));
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      // Don't sanitize password fields
      if (
        key.toLowerCase().includes("password") ||
        key.toLowerCase().includes("secret")
      ) {
        sanitized[key] = value;
      } else {
        sanitized[key] = filterXSS(value, {
          whiteList: {}, // Strip all HTML by default
          stripIgnoreTag: true,
          stripIgnoreTagBody: ["script", "style"],
        });
      }
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
};

/**
 * Middleware to sanitize request body
 */
const sanitizeInput = (req, res, next) => {
  // Never touch raw Buffer bodies (e.g. webhook routes using express.raw) —
  // iterating a Buffer would convert it into a plain {0:.., 1:..} object and
  // destroy the raw bytes needed for signature verification + JSON parsing.
  if (Buffer.isBuffer(req.body)) return next();
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeObject(req.body);
  }
  next();
};

module.exports = sanitizeInput;
