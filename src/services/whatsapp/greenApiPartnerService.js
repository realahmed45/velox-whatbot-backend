/**
 * Botlify Cloud — Partner Provisioning (white-labeled internally)
 *
 * Wraps the upstream provider's Partner API so we can auto-create / delete
 * messenger instances under our master account. Customers never see the
 * provider name; this service is back-office only.
 *
 * Required env:
 *   GREEN_API_PARTNER_TOKEN — partner key (request via support@green-api.com)
 *   GREEN_API_PARTNER_BASE  — optional, defaults to https://api.green-api.com
 *
 * Endpoints used:
 *   POST {base}/partner/createInstance/{token}
 *   POST {base}/partner/deleteInstanceAccount/{token}
 *   GET  {base}/partner/getInstances/{token}
 */
const axios = require("axios");
const logger = require("../../utils/logger");

const BASE = process.env.GREEN_API_PARTNER_BASE || "https://api.green-api.com";
const TOKEN = process.env.GREEN_API_PARTNER_TOKEN;

const isConfigured = () => !!TOKEN;

const partnerUrl = (path) => `${BASE}/partner/${path}/${TOKEN}`;

const safeError = (err) => {
  const raw =
    err.response?.data?.description || err.message || "Provider error";
  return String(raw).replace(/green[- ]?api/gi, "Botlify Cloud");
};

/**
 * Create a messenger instance for a tenant.
 *
 * @param {Object} opts
 * @param {string} opts.name         Friendly name for the instance.
 * @param {string} opts.webhookUrl   Where the provider should POST events.
 * @param {string} opts.webhookToken Shared secret appended to webhook URL.
 * @returns {Promise<{success:boolean, idInstance?:number, apiTokenInstance?:string, apiUrl?:string, mediaUrl?:string, error?:string}>}
 */
const createInstance = async ({ name, webhookUrl, webhookToken }) => {
  if (!isConfigured()) {
    return { success: false, error: "Partner provisioning not configured" };
  }
  try {
    const { data } = await axios.post(
      partnerUrl("createInstance"),
      {
        name: name || "Botlify",
        webhookUrl: webhookUrl || "",
        webhookUrlToken: webhookToken || "",
        delaySendMessagesMilliseconds: 1000,
        markIncomingMessagesReaded: "no",
        markIncomingMessagesReadedOnReply: "no",
        outgoingWebhook: "yes",
        outgoingMessageWebhook: "yes",
        outgoingAPIMessageWebhook: "yes",
        incomingWebhook: "yes",
        stateWebhook: "yes",
        keepOnlineStatus: "no",
        pollMessageWebhook: "no",
        incomingCallWebhook: "no",
        editedMessageWebhook: "no",
        deletedMessageWebhook: "no",
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 20000,
      },
    );

    // Errors come back with HTTP 200 and a code/description body.
    if (data?.code && data.code !== 200) {
      logger.error("[partner] createInstance non-success", data);
      return {
        success: false,
        error: data.description || "Could not provision instance",
      };
    }

    if (!data?.idInstance || !data?.apiTokenInstance) {
      logger.error("[partner] createInstance malformed response", data);
      return { success: false, error: "Malformed provider response" };
    }

    return {
      success: true,
      idInstance: data.idInstance,
      apiTokenInstance: data.apiTokenInstance,
      apiUrl: data.apiUrl || BASE,
      mediaUrl: data.mediaUrl || BASE,
    };
  } catch (err) {
    logger.error("[partner] createInstance error", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

/**
 * Delete a tenant's instance. Should be called on disconnect so we stop
 * being billed for it.
 */
const deleteInstance = async ({ idInstance }) => {
  if (!isConfigured()) {
    return { success: false, error: "Partner provisioning not configured" };
  }
  try {
    const { data } = await axios.post(
      partnerUrl("deleteInstanceAccount"),
      { idInstance: Number(idInstance) },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      },
    );
    if (data?.code && data.code !== 200) {
      // 404 = already deleted; not really an error
      if (data.code === 404) return { success: true, alreadyDeleted: true };
      return { success: false, error: data.description };
    }
    return { success: !!data?.deleteInstanceAccount };
  } catch (err) {
    logger.error("[partner] deleteInstance error", safeError(err));
    return { success: false, error: safeError(err) };
  }
};

/**
 * List all instances on the partner account (admin diagnostics).
 */
const listInstances = async () => {
  if (!isConfigured()) {
    return { success: false, error: "Partner provisioning not configured" };
  }
  try {
    const { data } = await axios.get(partnerUrl("getInstances"), {
      timeout: 15000,
    });
    return { success: true, instances: Array.isArray(data) ? data : [] };
  } catch (err) {
    return { success: false, error: safeError(err) };
  }
};

module.exports = {
  isConfigured,
  createInstance,
  deleteInstance,
  listInstances,
};
