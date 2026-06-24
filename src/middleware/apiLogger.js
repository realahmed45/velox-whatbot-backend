/**
 * Botlify — API Request Logger Middleware
 * Comprehensive logging for compliance, debugging, and monitoring
 */
const logger = require("../utils/logger");

/**
 * Log all API requests with timing, user context, and response status
 */
const apiLogger = (req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;

  // Capture response
  res.send = function (data) {
    const duration = Date.now() - start;

    const logData = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      userId: req.user?._id?.toString() || null,
      workspaceId: req.workspace?._id?.toString() || null,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    };

    // Log based on status and performance
    if (res.statusCode >= 500) {
      logger.error(`API Server Error: ${req.method} ${req.path}`, logData);
    } else if (res.statusCode >= 400) {
      logger.warn(`API Client Error: ${req.method} ${req.path}`, logData);
    } else if (duration > 2000) {
      logger.warn(`API Slow Request: ${req.method} ${req.path}`, logData);
    } else {
      logger.info(`API: ${req.method} ${req.path}`, logData);
    }

    // Restore original send
    res.send = originalSend;
    return res.send(data);
  };

  next();
};

/**
 * Log sensitive actions for compliance audit trail
 */
const auditLog = (action, details = {}) => {
  return (req, res, next) => {
    const auditData = {
      timestamp: new Date().toISOString(),
      action,
      userId: req.user?._id?.toString() || null,
      workspaceId: req.workspace?._id?.toString() || null,
      ip: req.ip,
      details,
    };

    logger.info(`[AUDIT] ${action}`, auditData);
    next();
  };
};

module.exports = {
  apiLogger,
  auditLog,
};
