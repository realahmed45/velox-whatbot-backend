/**
 * Smart Orders helper — parse the AI's hidden `<<ORDER_JSON>>{...}<<END_ORDER>>`
 * block, persist an Order document, and notify the merchant.
 *
 * The block is appended by the AI when (and only when) the customer has
 * provided everything needed (items + name + address). See the system prompt
 * in services/ai/index.js (SMART ORDERS MODE section).
 */
const Order = require("../models/Order");
const Workspace = require("../models/Workspace");
const logger = require("../utils/logger");
const emailService = require("./emailService");

const ORDER_RE = /<<ORDER_JSON>>([\s\S]*?)<<END_ORDER>>/i;

/**
 * Parse an AI reply for the order JSON sentinel.
 * Returns { cleanReply, orderData|null } — cleanReply has the sentinel removed.
 */
const parseAiOrderBlock = (rawReply) => {
  if (!rawReply || typeof rawReply !== "string") {
    return { cleanReply: rawReply, orderData: null };
  }
  const match = rawReply.match(ORDER_RE);
  if (!match) return { cleanReply: rawReply, orderData: null };

  const cleanReply = rawReply.replace(ORDER_RE, "").trim();
  let orderData = null;
  try {
    orderData = JSON.parse(match[1].trim());
  } catch (err) {
    logger.warn(`[smartOrders] order JSON parse failed: ${err.message}`);
    return { cleanReply, orderData: null };
  }

  // Light validation: must have at least one item + customerName + address
  if (
    !Array.isArray(orderData.items) ||
    orderData.items.length === 0 ||
    !orderData.customerName ||
    !orderData.customerAddress
  ) {
    logger.warn("[smartOrders] order block missing required fields");
    return { cleanReply, orderData: null };
  }

  return { cleanReply, orderData };
};

/**
 * Persist an Order, increment usage, emit socket event, send email + optional
 * merchant WA ping. Safe to call from anywhere (errors are caught & logged).
 */
const persistOrder = async ({
  workspace,
  contact,
  conversation,
  channel,
  orderData,
}) => {
  try {
    if (!workspace?.smartOrders?.enabled) return null;

    // Plan limit check
    const planId =
      workspace.subscription?.planId || workspace.subscription?.plan;
    const planLimit = getOrderLimit(planId);
    const used = workspace.smartOrders.monthlyOrderCount || 0;
    if (planLimit !== -1 && used >= planLimit) {
      logger.warn(
        `[smartOrders] workspace ${workspace._id} hit monthly order limit (${used}/${planLimit})`,
      );
      return { limitReached: true };
    }

    const items = (orderData.items || []).map((it) => ({
      name: String(it.name || "").slice(0, 200),
      qty: Math.max(1, parseInt(it.qty) || 1),
      variant: String(it.variant || "").slice(0, 100),
      price: Number(it.price) || 0,
    }));

    const itemsText = items
      .map(
        (it) =>
          `${it.qty}× ${it.name}${it.variant ? ` (${it.variant})` : ""}${it.price ? ` — ${it.price}` : ""}`,
      )
      .join(", ");

    const order = await Order.create({
      workspaceId: workspace._id,
      contactId: contact?._id,
      conversationId: conversation?._id,
      channel: channel || "whatsapp",
      items,
      itemsText,
      subtotal: Number(orderData.subtotal) || 0,
      currency: orderData.currency || "PKR",
      customerName: String(orderData.customerName || "").slice(0, 200),
      customerPhone: String(
        orderData.customerPhone || contact?.phone || "",
      ).slice(0, 32),
      customerAddress: String(orderData.customerAddress || "").slice(0, 500),
      customerNotes: String(orderData.notes || "").slice(0, 500),
      paymentMethod: String(orderData.paymentMethod || "").slice(0, 100),
      source: "ai",
      status: "new",
    });

    // Bump usage counter atomically (avoid mongoose VersionError)
    await Workspace.updateOne(
      { _id: workspace._id },
      { $inc: { "smartOrders.monthlyOrderCount": 1 } },
    );

    // Fire socket event
    try {
      const { getIO } = require("../socket");
      const io = getIO();
      if (io) {
        io.to(`workspace:${workspace._id}`).emit("order:new", {
          order: order.toObject(),
        });
      }
    } catch (err) {
      logger.warn(`[smartOrders] socket emit failed: ${err.message}`);
    }

    // Email merchant (best-effort)
    sendMerchantOrderEmail(workspace, order).catch((err) =>
      logger.warn(`[smartOrders] email failed: ${err.message}`),
    );

    // Optional WhatsApp ping to the merchant's notifyPhone
    if (workspace.smartOrders.notifyPhone) {
      sendMerchantWaPing(workspace, order).catch((err) =>
        logger.warn(`[smartOrders] merchant WA ping failed: ${err.message}`),
      );
    }

    logger.info(
      `[smartOrders] order ${order._id} captured (workspace ${workspace._id}, ${items.length} items, total ${order.subtotal})`,
    );
    return order;
  } catch (err) {
    logger.error(`[smartOrders] persistOrder failed: ${err.message}`);
    return null;
  }
};

const getOrderLimit = (planId) => {
  // Conservative defaults; real numbers come from plans.js limits.smartOrdersLimit
  try {
    const plans = require("../config/plans");
    const plan = plans?.PLANS?.[planId] || plans?.plans?.[planId];
    const lim =
      plan?.limits?.smartOrdersPerMonth ?? plan?.limits?.smartOrdersLimit;
    if (typeof lim === "number") return lim;
  } catch (_) {
    /* ignore */
  }
  return 50; // safe default if plan config not loaded
};

const sendMerchantOrderEmail = async (workspace, order) => {
  try {
    const owner = workspace.ownerEmail || workspace.email;
    let toEmail = owner;
    if (!toEmail) {
      // Best-effort lookup from User model
      const User = require("../models/User");
      const ownerUser = await User.findById(workspace.owner).select(
        "email name",
      );
      if (!ownerUser?.email) return;
      toEmail = ownerUser.email;
    }
    const itemLines = order.items
      .map(
        (it) =>
          `<li>${it.qty}× <b>${escapeHtml(it.name)}</b>${it.variant ? ` (${escapeHtml(it.variant)})` : ""}${it.price ? ` — ${it.price} ${order.currency}` : ""}</li>`,
      )
      .join("");

    const dashboardUrl =
      (process.env.FRONTEND_URL || "https://botlify.site") +
      "/dashboard/orders";

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:12px">
        <h2 style="color:#0f172a;margin:0 0 8px">🛒 New order received</h2>
        <p style="color:#475569;margin:0 0 16px">A customer just placed an order through your AI bot.</p>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px">
          <p style="margin:0 0 4px"><b>Customer:</b> ${escapeHtml(order.customerName || "—")}</p>
          ${order.customerPhone ? `<p style="margin:0 0 4px"><b>Phone:</b> ${escapeHtml(order.customerPhone)}</p>` : ""}
          <p style="margin:0 0 4px"><b>Address:</b> ${escapeHtml(order.customerAddress || "—")}</p>
          ${order.paymentMethod ? `<p style="margin:0 0 4px"><b>Payment:</b> ${escapeHtml(order.paymentMethod)}</p>` : ""}
          ${order.customerNotes ? `<p style="margin:0 0 4px"><b>Notes:</b> ${escapeHtml(order.customerNotes)}</p>` : ""}
        </div>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px">
          <p style="margin:0 0 8px"><b>Items:</b></p>
          <ul style="margin:0;padding-left:20px">${itemLines}</ul>
          ${order.subtotal ? `<p style="margin:12px 0 0;font-weight:bold">Total: ${order.subtotal} ${order.currency}</p>` : ""}
        </div>
        <a href="${dashboardUrl}" style="display:inline-block;background:#0d9488;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">View order in dashboard</a>
        <p style="color:#94a3b8;font-size:12px;margin-top:24px">You're receiving this because Smart Orders is enabled on your workspace.</p>
      </div>
    `;
    await emailService.sendEmail({
      to: toEmail,
      subject: `🛒 New order from ${order.customerName || "a customer"}${order.subtotal ? ` — ${order.subtotal} ${order.currency}` : ""}`,
      html,
    });
  } catch (err) {
    throw err;
  }
};

const sendMerchantWaPing = async (workspace, order) => {
  const dispatcher = require("./whatsapp/dispatcher");
  const phone = workspace.smartOrders.notifyPhone;
  if (!phone) return;
  const summary = order.items
    .map(
      (it) => `• ${it.qty}× ${it.name}${it.variant ? ` (${it.variant})` : ""}`,
    )
    .join("\n");
  const text =
    `🛒 *New order!*\n\n` +
    `*Customer:* ${order.customerName || "—"}\n` +
    (order.customerPhone ? `*Phone:* ${order.customerPhone}\n` : "") +
    `*Address:* ${order.customerAddress || "—"}\n\n` +
    `*Items:*\n${summary}\n` +
    (order.subtotal ? `\n*Total:* ${order.subtotal} ${order.currency}\n` : "") +
    `\nView in dashboard: ${process.env.FRONTEND_URL || "https://botlify.site"}/dashboard/orders`;
  await dispatcher.sendMessage(workspace, phone, { type: "text", text });
};

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

module.exports = {
  parseAiOrderBlock,
  persistOrder,
};
