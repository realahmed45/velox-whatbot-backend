/**
 * Admin activity recorder. Fire-and-forget: never throws into the caller, so a
 * logging failure can't break signup/connect/payment flows.
 */
const AdminEvent = require("../models/AdminEvent");
const logger = require("../utils/logger");

const EVENTS = {
  SIGNUP: "signup",
  ONBOARDED: "onboarded",
  IG_CONNECTED: "ig_connected",
  IG_DISCONNECTED: "ig_disconnected",
  TRIAL_STARTED: "trial_started",
  PAYMENT: "payment",
  TRIAL_EXPIRED: "trial_expired",
  KNOWLEDGE_ADDED: "knowledge_added",
  CANCELLED: "cancelled",
};

/**
 * Record an admin activity event. Always resolves; logs on failure.
 * @param {string} type   one of EVENTS
 * @param {object} data   { userId, userEmail, userName, workspaceId, message, meta }
 */
const record = async (type, data = {}) => {
  try {
    await AdminEvent.create({
      type,
      message: data.message || "",
      userId: data.userId,
      userEmail: data.userEmail || "",
      userName: data.userName || "",
      workspaceId: data.workspaceId,
      meta: data.meta || {},
    });
  } catch (err) {
    logger.warn("[adminEvents] record failed", { type, err: err.message });
  }
};

module.exports = { record, EVENTS };
