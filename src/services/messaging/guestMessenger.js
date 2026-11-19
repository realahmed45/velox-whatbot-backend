/**
 * guestMessenger — send a message to a guest in the conversation they're
 * already in (WhatsApp / Instagram / booking-site inbox), and keep a copy in
 * the inbox so the hotel sees what was sent.
 *
 * Used for system messages that don't come from the AI turn itself: payment
 * received, driver assigned, driver arriving.
 */
const logger = require("../../utils/logger");

async function messageGuest(conversationId, text) {
  if (!conversationId || !text) return { ok: false, reason: "nothing_to_send" };
  const Conversation = require("../../models/Conversation");
  const Contact = require("../../models/Contact");
  const Workspace = require("../../models/Workspace");

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) return { ok: false, reason: "no_conversation" };
  const [workspace, contact] = await Promise.all([
    Workspace.findById(conversation.workspaceId),
    Contact.findById(conversation.contactId),
  ]);
  if (!workspace || !contact?.igUserId) return { ok: false, reason: "no_contact" };

  const { resolveSendTransport } = require("../instagram/automationEngine");
  const transport = await resolveSendTransport(workspace, conversation);
  const result = await transport.send(contact.igUserId, text, {
    conversationId: conversation.metadata?.providerConversationId,
  });
  if (!result?.success) {
    logger.warn(`[guestMessenger] send failed conv=${conversationId}: ${result?.error || "unknown"}`);
    return { ok: false, reason: result?.error || "send_failed" };
  }

  try {
    const Message = require("../../models/Message");
    await Message.create({
      workspaceId: workspace._id,
      conversationId: conversation._id,
      contactId: contact._id,
      direction: "outbound",
      text,
      sender: "bot",
      status: "sent",
    });
  } catch (e) {
    // The guest got it; an inbox copy failing must not matter.
    logger.debug?.(`[guestMessenger] inbox copy skipped: ${e.message}`);
  }
  return { ok: true };
}

module.exports = { messageGuest };
