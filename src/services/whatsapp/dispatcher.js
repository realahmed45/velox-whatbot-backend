/**
 * WhatsApp Message Dispatcher
 * Routes messages to the correct provider (Meta or UltraMsg) based on workspace config
 */
const metaService = require("./metaService");
const ultramsgService = require("./ultramsgService");
const greenApiService = require("./greenApiService");
const { decrypt } = require("../../utils/encryption");
const logger = require("../../utils/logger");

/**
 * Send a message from a workspace to a phone number
 * Automatically selects the correct provider
 */
const sendMessage = async (workspace, to, messagePayload) => {
  const { type } = workspace.whatsapp || {};

  if (!type || type === "none") {
    return {
      success: false,
      error: "WhatsApp not connected for this workspace",
    };
  }

  if (type === "meta") {
    const phoneNumberId = decrypt(workspace.whatsapp.metaPhoneNumberId);
    const accessToken = decrypt(workspace.whatsapp.metaAccessToken);
    return dispatchMetaMessage({
      phoneNumberId,
      accessToken,
      to,
      messagePayload,
    });
  }

  if (type === "ultramsg") {
    const instanceId = decrypt(workspace.whatsapp.ultralmsgInstanceId);
    const token = decrypt(workspace.whatsapp.ultramsgToken);
    return dispatchUltramsgMessage({ instanceId, token, to, messagePayload });
  }

  if (type === "cloud") {
    const idInstance = decrypt(workspace.whatsapp.cloudInstanceId);
    const apiTokenInstance = decrypt(workspace.whatsapp.cloudApiToken);
    return dispatchCloudMessage({
      idInstance,
      apiTokenInstance,
      to,
      messagePayload,
    });
  }

  return { success: false, error: "WhatsApp provider not configured" };
};

const dispatchCloudMessage = async ({
  idInstance,
  apiTokenInstance,
  to,
  messagePayload,
}) => {
  switch (messagePayload.type) {
    case "text":
      return greenApiService.sendTextMessage({
        idInstance,
        apiTokenInstance,
        to,
        text: messagePayload.text,
      });
    case "image":
      return greenApiService.sendImageMessage({
        idInstance,
        apiTokenInstance,
        to,
        imageUrl: messagePayload.imageUrl,
        caption: messagePayload.caption,
      });
    case "document":
      return greenApiService.sendDocumentMessage({
        idInstance,
        apiTokenInstance,
        to,
        fileUrl: messagePayload.fileUrl,
        fileName: messagePayload.fileName,
      });
    case "buttons": {
      // Cloud provider does not natively render interactive buttons →
      // fall back to numbered list in plain text.
      const lines = (messagePayload.buttons || [])
        .map((b, i) => `${i + 1}. ${b.label}`)
        .join("\n");
      return greenApiService.sendTextMessage({
        idInstance,
        apiTokenInstance,
        to,
        text: `${messagePayload.text || ""}\n\n${lines}`.trim(),
      });
    }
    default:
      return greenApiService.sendTextMessage({
        idInstance,
        apiTokenInstance,
        to,
        text: messagePayload.text || "[Unsupported message type]",
      });
  }
};

const dispatchMetaMessage = async ({
  phoneNumberId,
  accessToken,
  to,
  messagePayload,
}) => {
  switch (messagePayload.type) {
    case "text":
      return metaService.sendTextMessage({
        phoneNumberId,
        accessToken,
        to,
        text: messagePayload.text,
      });
    case "image":
      return metaService.sendImageMessage({
        phoneNumberId,
        accessToken,
        to,
        imageUrl: messagePayload.imageUrl,
        caption: messagePayload.caption,
      });
    case "document":
      return metaService.sendDocumentMessage({
        phoneNumberId,
        accessToken,
        to,
        fileUrl: messagePayload.fileUrl,
        fileName: messagePayload.fileName,
      });
    case "buttons":
      return metaService.sendButtonMessage({
        phoneNumberId,
        accessToken,
        to,
        bodyText: messagePayload.text,
        buttons: messagePayload.buttons,
        headerText: messagePayload.header,
        footerText: messagePayload.footer,
      });
    case "list":
      return metaService.sendListMessage({
        phoneNumberId,
        accessToken,
        to,
        bodyText: messagePayload.text,
        buttonText: messagePayload.buttonText,
        sections: messagePayload.sections,
        headerText: messagePayload.header,
        footerText: messagePayload.footer,
      });
    default:
      return metaService.sendTextMessage({
        phoneNumberId,
        accessToken,
        to,
        text: messagePayload.text || "[Unsupported message type]",
      });
  }
};

const dispatchUltramsgMessage = async ({
  instanceId,
  token,
  to,
  messagePayload,
}) => {
  switch (messagePayload.type) {
    case "text":
      return ultramsgService.sendTextMessage({
        instanceId,
        token,
        to,
        text: messagePayload.text,
      });
    case "image":
      return ultramsgService.sendImageMessage({
        instanceId,
        token,
        to,
        imageUrl: messagePayload.imageUrl,
        caption: messagePayload.caption,
      });
    case "document":
      return ultramsgService.sendDocumentMessage({
        instanceId,
        token,
        to,
        fileUrl: messagePayload.fileUrl,
        fileName: messagePayload.fileName,
      });
    // UltraMsg doesn't support interactive buttons — fall back to text
    case "buttons":
      const buttonText = `${messagePayload.text}\n\n${messagePayload.buttons.map((b, i) => `${i + 1}. ${b.label}`).join("\n")}`;
      return ultramsgService.sendTextMessage({
        instanceId,
        token,
        to,
        text: buttonText,
      });
    default:
      return ultramsgService.sendTextMessage({
        instanceId,
        token,
        to,
        text: messagePayload.text || "[Unsupported message type]",
      });
  }
};

module.exports = { sendMessage };
