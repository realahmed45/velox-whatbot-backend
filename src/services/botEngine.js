/**
 * Bot Engine — Core WhatsApp Automation Flow Executor
 *
 * When a message is received:
 * 1. Find workspace by phone number ID
 * 2. Get/create contact record
 * 3. Get/create conversation
 * 4. If conversation is in human_active mode — skip bot
 * 5. If conversation has active flow state — continue the flow
 * 6. Otherwise — match triggers from active flows (by priority)
 * 7. Execute matched flow nodes in sequence
 */
const Flow = require("../models/Flow");
const Contact = require("../models/Contact");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const Workspace = require("../models/Workspace");
const { sendMessage } = require("./whatsapp/dispatcher");
const { getIO } = require("../socket");
const logger = require("../utils/logger");

/**
 * Main entry point — process an incoming WhatsApp message
 */
const processIncomingMessage = async ({
  workspace,
  phone,
  messageBody,
  messageType = "text",
  mediaUrl,
  buttonPayload,
}) => {
  try {
    // 1. Get or create contact
    let contact = await Contact.findOne({ workspaceId: workspace._id, phone });
    if (!contact) {
      contact = await Contact.create({
        workspaceId: workspace._id,
        phone,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      });
    } else {
      contact.lastSeenAt = new Date();
      contact.lastMessageAt = new Date();
      contact.messageCount += 1;
      await contact.save();
    }

    // 2. Get or create conversation
    let conversation = await Conversation.findOne({
      workspaceId: workspace._id,
      phone,
      status: { $in: ["bot_active", "awaiting_human", "human_active"] },
    }).sort({ lastMessageAt: -1 });

    if (!conversation) {
      conversation = await Conversation.create({
        workspaceId: workspace._id,
        contactId: contact._id,
        phone,
        status: "bot_active",
        lastMessageAt: new Date(),
      });
    }

    // 3. Save incoming message to DB
    const incomingMsg = await Message.create({
      workspaceId: workspace._id,
      conversationId: conversation._id,
      contactId: contact._id,
      direction: "inbound",
      type: messageType,
      sender: "customer",
      text: messageBody,
      mediaUrl,
      status: "delivered",
    });

    // Update conversation
    conversation.lastMessageAt = new Date();
    conversation.lastMessagePreview = messageBody?.slice(0, 60) || "[Media]";
    conversation.unreadByAgentCount += 1;
    await conversation.save();

    // Emit to dashboard via socket
    const io = getIO();
    if (io) {
      io.to(`workspace:${workspace._id}`).emit("message:new", {
        message: incomingMsg,
        conversation,
        contact,
      });
    }

    // 4. If human is handling this conversation — don't trigger bot
    if (conversation.status === "human_active") {
      logger.info(
        `Conversation ${conversation._id} is under human control — skipping bot`,
      );
      return;
    }

    // 5. Check if workspace bot is enabled & within business hours
    if (!workspace.settings?.botEnabled) {
      logger.info(`Bot disabled for workspace ${workspace._id}`);
      return;
    }

    if (!isWithinBusinessHours(workspace)) {
      await sendOutsideHoursMessage(workspace, conversation, phone, contact);
      return;
    }

    // 6. Check message/overage limits
    const limits = workspace.getPlanLimits();
    if (workspace.usage.messagesThisMonth >= limits.messages) {
      logger.warn(`Workspace ${workspace._id} exceeded message limit`);
      return; // Don't respond — usage limit hit
    }

    // 7. Continue active flow state or match new trigger
    if (
      conversation.flowState?.waitingForInput &&
      conversation.flowState?.currentNodeId
    ) {
      await continueFlow(
        workspace,
        conversation,
        contact,
        messageBody,
        buttonPayload,
      );
    } else {
      await matchAndStartFlow(
        workspace,
        conversation,
        contact,
        messageBody,
        buttonPayload,
      );
    }
  } catch (err) {
    logger.error("BotEngine processIncomingMessage error", {
      error: err.message,
      phone,
    });
  }
};

/**
 * Match a trigger and start a new flow
 */
const matchAndStartFlow = async (
  workspace,
  conversation,
  contact,
  messageBody,
  buttonPayload,
) => {
  const flows = await Flow.find({
    workspaceId: workspace._id,
    status: "active",
  }).sort({ priority: -1 });

  if (!flows.length) {
    logger.info(`No active flows for workspace ${workspace._id}`);
    return;
  }

  const isFirstMessage = contact.messageCount <= 1;

  for (const flow of flows) {
    const triggerNode = flow.nodes.find((n) => n.type === "trigger");
    if (!triggerNode) continue;

    const matched = evaluateTrigger(
      triggerNode,
      messageBody,
      isFirstMessage,
      buttonPayload,
    );
    if (matched) {
      logger.info(`Flow "${flow.name}" triggered for ${contact.phone}`);

      // Update flow stats
      await Flow.findByIdAndUpdate(flow._id, {
        $inc: { "stats.totalTriggers": 1 },
        "stats.lastTriggeredAt": new Date(),
      });

      // Set flow state on conversation
      conversation.flowState = {
        flowId: flow._id,
        currentNodeId: triggerNode.id,
        waitingForInput: false,
        variables: {},
        startedAt: new Date(),
        lastNodeAt: new Date(),
      };
      conversation.status = "bot_active";
      await conversation.save();

      // Execute the next node after the trigger
      const firstEdge = flow.edges.find((e) => e.source === triggerNode.id);
      if (firstEdge) {
        await executeNode(
          workspace,
          conversation,
          contact,
          flow,
          firstEdge.target,
        );
      }
      return;
    }
  }

  logger.info(
    `No trigger matched for message: "${messageBody}" in workspace ${workspace._id}`,
  );
};

/**
 * Continue an in-progress flow (waiting for user input)
 */
const continueFlow = async (
  workspace,
  conversation,
  contact,
  messageBody,
  buttonPayload,
) => {
  const { flowId, currentNodeId, waitingForVariable } = conversation.flowState;

  const flow = await Flow.findById(flowId);
  if (!flow) {
    conversation.flowState = null;
    await conversation.save();
    return matchAndStartFlow(
      workspace,
      conversation,
      contact,
      messageBody,
      buttonPayload,
    );
  }

  const currentNode = flow.nodes.find((n) => n.id === currentNodeId);
  if (!currentNode) return;

  // Save captured variable
  if (waitingForVariable && messageBody) {
    const variables = conversation.flowState.variables || {};
    variables[waitingForVariable] = messageBody;
    conversation.flowState.variables = variables;
    conversation.flowState.waitingForInput = false;
    conversation.flowState.waitingForVariable = null;
    await conversation.save();

    // Also save to contact record
    if (!contact.variables) contact.variables = new Map();
    contact.variables.set(waitingForVariable, messageBody);
    await contact.save();
  }

  // Handle button click response
  let nextNodeId;
  if (buttonPayload && currentNode.nodeType === "button_menu") {
    const button = currentNode.data?.buttons?.find(
      (b) => b.id === buttonPayload,
    );
    nextNodeId = button?.nextNodeId;
  } else {
    // For text responses to ask_question nodes — move to next edge
    const nextEdge = flow.edges.find((e) => e.source === currentNodeId);
    nextNodeId = nextEdge?.target;
  }

  if (nextNodeId) {
    await executeNode(workspace, conversation, contact, flow, nextNodeId);
  } else {
    // Flow complete
    conversation.flowState = null;
    await conversation.save();
  }
};

/**
 * Execute a specific node in a flow
 */
const executeNode = async (workspace, conversation, contact, flow, nodeId) => {
  const node = flow.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  // Replace variables in text
  const renderText = (text) => {
    if (!text) return text;
    const vars = {
      ...Object.fromEntries(contact.variables || []),
      ...Object.fromEntries(
        Object.entries(conversation.flowState?.variables || {}),
      ),
    };
    return text.replace(
      /\{\{(\w+)\}\}/g,
      (_, key) => vars[key] || `{{${key}}}`,
    );
  };

  conversation.flowState.currentNodeId = nodeId;
  conversation.flowState.lastNodeAt = new Date();
  await conversation.save();

  switch (node.nodeType) {
    case "send_text": {
      const text = renderText(node.data?.message);
      await sendBotMessage(workspace, conversation, contact, flow, node, {
        type: "text",
        text,
      });
      // Auto-advance
      const next = flow.edges.find((e) => e.source === nodeId);
      if (next)
        await executeNode(workspace, conversation, contact, flow, next.target);
      break;
    }

    case "send_image": {
      await sendBotMessage(workspace, conversation, contact, flow, node, {
        type: "image",
        imageUrl: node.data?.imageUrl,
        caption: renderText(node.data?.message),
      });
      const next = flow.edges.find((e) => e.source === nodeId);
      if (next)
        await executeNode(workspace, conversation, contact, flow, next.target);
      break;
    }

    case "send_file": {
      await sendBotMessage(workspace, conversation, contact, flow, node, {
        type: "document",
        fileUrl: node.data?.fileUrl,
        fileName: node.data?.fileName,
      });
      const next = flow.edges.find((e) => e.source === nodeId);
      if (next)
        await executeNode(workspace, conversation, contact, flow, next.target);
      break;
    }

    case "ask_question": {
      const questionText = renderText(node.data?.questionText);
      await sendBotMessage(workspace, conversation, contact, flow, node, {
        type: "text",
        text: questionText,
      });
      // Pause and wait for input
      conversation.flowState.waitingForInput = true;
      conversation.flowState.waitingForVariable = node.data?.variableName;
      conversation.flowState.currentNodeId = nodeId;
      await conversation.save();
      break;
    }

    case "button_menu": {
      await sendBotMessage(workspace, conversation, contact, flow, node, {
        type: "buttons",
        text: renderText(node.data?.message),
        buttons: node.data?.buttons || [],
      });
      conversation.flowState.waitingForInput = true;
      conversation.flowState.currentNodeId = nodeId;
      await conversation.save();
      break;
    }

    case "list_menu": {
      await sendBotMessage(workspace, conversation, contact, flow, node, {
        type: "list",
        text: renderText(node.data?.message),
        sections: node.data?.listSections || [],
      });
      conversation.flowState.waitingForInput = true;
      conversation.flowState.currentNodeId = nodeId;
      await conversation.save();
      break;
    }

    case "delay": {
      const seconds = Math.min(node.data?.delaySeconds || 1, 30);
      await sleep(seconds * 1000);
      const next = flow.edges.find((e) => e.source === nodeId);
      if (next)
        await executeNode(workspace, conversation, contact, flow, next.target);
      break;
    }

    case "assign_agent": {
      conversation.status = "awaiting_human";
      conversation.assignedTo = node.data?.agentId || null;
      conversation.flowState = null;
      await conversation.save();
      const io = getIO();
      if (io) {
        io.to(`workspace:${workspace._id}`).emit("conversation:updated", {
          conversation,
          type: "assigned",
        });
      }
      break;
    }

    case "tag_contact": {
      const tag = node.data?.tagName?.toLowerCase();
      if (tag && !contact.tags.includes(tag)) {
        contact.tags.push(tag);
        await contact.save();
      }
      const next = flow.edges.find((e) => e.source === nodeId);
      if (next)
        await executeNode(workspace, conversation, contact, flow, next.target);
      break;
    }

    case "condition": {
      const varValue = (
        conversation.flowState?.variables?.[node.data?.conditionVariable] || ""
      ).toLowerCase();
      const condValue = (node.data?.conditionValue || "").toLowerCase();
      let conditionMet = false;

      switch (node.data?.conditionOperator) {
        case "contains":
          conditionMet = varValue.includes(condValue);
          break;
        case "equals":
          conditionMet = varValue === condValue;
          break;
        case "starts_with":
          conditionMet = varValue.startsWith(condValue);
          break;
        case "ends_with":
          conditionMet = varValue.endsWith(condValue);
          break;
        case "not_contains":
          conditionMet = !varValue.includes(condValue);
          break;
        default:
          conditionMet = false;
      }

      const thenEdge = flow.edges.find(
        (e) => e.source === nodeId && e.sourceHandle === "then",
      );
      const elseEdge = flow.edges.find(
        (e) => e.source === nodeId && e.sourceHandle === "else",
      );
      const nextEdge = conditionMet ? thenEdge : elseEdge;
      if (nextEdge)
        await executeNode(
          workspace,
          conversation,
          contact,
          flow,
          nextEdge.target,
        );
      break;
    }

    case "end_flow": {
      conversation.status = "resolved";
      conversation.resolvedAt = new Date();
      conversation.flowState = null;
      await conversation.save();
      await Flow.findByIdAndUpdate(flow._id, {
        $inc: { "stats.completions": 1 },
      });
      const io = getIO();
      if (io) {
        io.to(`workspace:${workspace._id}`).emit("conversation:updated", {
          conversation,
          type: "resolved",
        });
      }
      break;
    }

    default:
      logger.warn(`Unknown node type: ${node.nodeType}`);
  }
};

/**
 * Send a bot message and record it in DB
 */
const sendBotMessage = async (
  workspace,
  conversation,
  contact,
  flow,
  node,
  payload,
) => {
  try {
    const result = await sendMessage(workspace, contact.phone, payload);

    const msgData = {
      workspaceId: workspace._id,
      conversationId: conversation._id,
      contactId: contact._id,
      direction: "outbound",
      sender: "bot",
      type: payload.type === "text" ? "text" : payload.type,
      text: payload.text,
      mediaUrl: payload.imageUrl || payload.fileUrl,
      fileName: payload.fileName,
      status: result.success ? "sent" : "failed",
      whatsappMessageId: result.messageId,
      flowId: flow._id,
      nodeId: node.id,
      failureReason: result.success ? undefined : result.error,
    };

    const message = await Message.create(msgData);

    // Increment usage counter
    if (result.success) {
      await Workspace.findByIdAndUpdate(workspace._id, {
        $inc: { "usage.messagesThisMonth": 1 },
        "whatsapp.lastMessageAt": new Date(),
      });
    }

    // Emit to dashboard
    const io = getIO();
    if (io) {
      io.to(`workspace:${workspace._id}`).emit("message:new", {
        message,
        conversation,
        contact,
      });
      io.to(`workspace:${workspace._id}`).emit("bot:active", {
        conversationId: conversation._id,
        message,
      });
      io.to(`workspace:${workspace._id}`).emit("usage:updated", {
        workspaceId: workspace._id,
      });
    }

    return message;
  } catch (err) {
    logger.error("sendBotMessage error", { error: err.message });
    throw err;
  }
};

/**
 * Evaluate if a trigger node matches the incoming message
 */
const evaluateTrigger = (node, messageBody, isFirstMessage, buttonPayload) => {
  const { nodeType, data } = node;
  const body = (messageBody || "").toLowerCase().trim();

  switch (nodeType) {
    case "first_message":
      return isFirstMessage;

    case "any_message":
      return true;

    case "keyword_match": {
      const keywords = data?.keywords || [];
      const matchType = data?.matchType || "contains";
      return keywords.some((kw) => {
        const k = kw.toLowerCase().trim();
        switch (matchType) {
          case "exact":
            return body === k;
          case "contains":
            return body.includes(k);
          case "starts_with":
            return body.startsWith(k);
          case "ends_with":
            return body.endsWith(k);
          default:
            return body.includes(k);
        }
      });
    }

    case "time_condition": {
      const now = new Date();
      const hour = now.getHours();
      const day = now
        .toLocaleDateString("en-US", { weekday: "long" })
        .toLowerCase();
      const days = data?.days || [];
      const { start, end } = data?.timeRange || {};
      if (!days.includes(day)) return false;
      const startHour = parseInt(start?.split(":")[0] || 0);
      const endHour = parseInt(end?.split(":")[0] || 23);
      return hour >= startHour && hour <= endHour;
    }

    case "button_click":
      return buttonPayload && buttonPayload === data?.buttonId;

    default:
      return false;
  }
};

/**
 * Check if current time is within workspace business hours
 */
const isWithinBusinessHours = (workspace) => {
  const hours = workspace.businessHours;
  if (!hours || !hours.length) return true; // No hours set = always open

  const now = new Date();
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const todayName = dayNames[now.getDay()];
  const todayHours = hours.find((h) => h.day === todayName);

  if (!todayHours || !todayHours.isOpen) return false;

  const [openH, openM] = (todayHours.openTime || "00:00")
    .split(":")
    .map(Number);
  const [closeH, closeM] = (todayHours.closeTime || "23:59")
    .split(":")
    .map(Number);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  return currentMinutes >= openMinutes && currentMinutes <= closeMinutes;
};

/**
 * Send outside-hours message
 */
const sendOutsideHoursMessage = async (
  workspace,
  conversation,
  phone,
  contact,
) => {
  const msg =
    workspace.settings?.outsideHoursMessage ||
    "We are currently closed. Please message us during business hours.";
  await sendMessage(workspace, phone, { type: "text", text: msg });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { processIncomingMessage };
