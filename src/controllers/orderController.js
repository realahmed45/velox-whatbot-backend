const asyncHandler = require("express-async-handler");
const Order = require("../models/Order");
const Contact = require("../models/Contact");
const Workspace = require("../models/Workspace");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const logger = require("../utils/logger");

// Try to send a confirmation/status message to the customer via Instagram DM
const sendCustomerMessage = async (workspace, order, text) => {
  try {
    if (!order.contactId) return;
    const ig = require("../services/instagram");
    const { decrypt } = require("../utils/encryption");
    const wsWithToken = await Workspace.findById(workspace._id).select("+instagram.accessToken");
    if (!wsWithToken?.instagram?.accessToken) return;
    const token = decrypt(wsWithToken.instagram.accessToken);
    const contact = await Contact.findById(order.contactId).select("igUserId");
    if (contact?.igUserId) {
      await ig.sendDM(token, contact.igUserId, text);
      if (order.conversationId) {
        await Message.create({
          workspaceId: workspace._id,
          conversationId: order.conversationId,
          contactId: order.contactId,
          direction: "outbound",
          type: "text",
          sender: "system",
          channelType: "instagram",
          text,
          status: "sent",
        });
      }
    }
  } catch (err) {
    logger.warn(`[orders] sendCustomerMessage failed: ${err.message}`);
  }
};

// @GET /api/orders
const listOrders = asyncHandler(async (req, res) => {
  const { status, channel, search, page = 1, limit = 50 } = req.query;
  const filter = { workspaceId: req.workspace._id };
  if (status && status !== "all") filter.status = status;
  if (channel && channel !== "all") filter.channel = channel;
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { customerName: rx },
      { customerPhone: rx },
      { customerAddress: rx },
      { itemsText: rx },
    ];
  }
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    Order.countDocuments(filter),
  ]);

  // Lightweight counts per status for the UI tabs
  const counts = await Order.aggregate([
    { $match: { workspaceId: req.workspace._id } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const statusCounts = counts.reduce(
    (acc, c) => ({ ...acc, [c._id]: c.count }),
    { new: 0, confirmed: 0, shipped: 0, delivered: 0, cancelled: 0 },
  );

  res.json({ success: true, orders, total, statusCounts });
});

// @GET /api/orders/:id
const getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!order) {
    res.status(404);
    throw new Error("Order not found");
  }
  res.json({ success: true, order });
});

// @POST /api/orders — manual order creation from the dashboard
const createOrder = asyncHandler(async (req, res) => {
  const {
    items,
    itemsText,
    customerName,
    customerPhone,
    customerAddress,
    customerNotes,
    paymentMethod,
    subtotal,
    currency,
    contactId,
    conversationId,
    channel,
  } = req.body || {};

  const order = await Order.create({
    workspaceId: req.workspace._id,
    contactId: contactId || undefined,
    conversationId: conversationId || undefined,
    channel: channel || "manual",
    items: Array.isArray(items) ? items : [],
    itemsText: itemsText || "",
    subtotal: Number(subtotal) || 0,
    currency: currency || "PKR",
    customerName: customerName || "",
    customerPhone: customerPhone || "",
    customerAddress: customerAddress || "",
    customerNotes: customerNotes || "",
    paymentMethod: paymentMethod || "",
    source: "manual",
    status: "new",
  });

  res.json({ success: true, order });
});

// @PATCH /api/orders/:id — update status, customer info, notes
const updateOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!order) {
    res.status(404);
    throw new Error("Order not found");
  }
  const ws = req.workspace;

  const allowed = [
    "customerName",
    "customerPhone",
    "customerAddress",
    "customerNotes",
    "merchantNotes",
    "paymentMethod",
    "subtotal",
    "currency",
    "items",
    "itemsText",
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) order[key] = req.body[key];
  }

  // Handle status transitions and fire automatic customer messages
  let messageToCustomer = null;
  if (req.body.status && req.body.status !== order.status) {
    const next = req.body.status;
    const prev = order.status;
    order.status = next;
    if (next === "confirmed" && !order.confirmedAt) {
      order.confirmedAt = new Date();
      messageToCustomer = `✅ Your order has been confirmed${order.customerName ? `, ${order.customerName}` : ""}! We're preparing it for delivery.`;
    } else if (next === "shipped" && !order.shippedAt) {
      order.shippedAt = new Date();
      messageToCustomer = `📦 Good news! Your order is on its way. We'll keep you posted.`;
    } else if (next === "delivered" && !order.deliveredAt) {
      order.deliveredAt = new Date();
      messageToCustomer = `🙏 Thanks for ordering with us! Hope you love it. Reply with any feedback — we read every message.`;
    } else if (next === "cancelled" && !order.cancelledAt) {
      order.cancelledAt = new Date();
      messageToCustomer = `Your order has been cancelled. If this is a mistake or you have questions, just reply here.`;
    }
    logger.info(
      `[orders] ${order._id} status ${prev} → ${next} (workspace ${req.workspace._id})`,
    );
  }

  await order.save();

  // Fire customer message after save (so DB is consistent even if dispatch fails)
  if (messageToCustomer && req.body.notifyCustomer !== false) {
    sendCustomerMessage(ws, order, messageToCustomer).catch(() => {});
  }

  res.json({ success: true, order });
});

// @DELETE /api/orders/:id
const deleteOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOneAndDelete({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!order) {
    res.status(404);
    throw new Error("Order not found");
  }
  res.json({ success: true });
});

// @POST /api/orders/:id/message — manually send a one-off message to the customer about this order
const sendOrderMessage = asyncHandler(async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) {
    res.status(400);
    throw new Error("Message text is required");
  }
  const order = await Order.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!order) {
    res.status(404);
    throw new Error("Order not found");
  }
  await sendCustomerMessage(req.workspace, order, text.trim());
  res.json({ success: true });
});

// @GET /api/orders/stats/summary — small summary for dashboard cards
const getOrderStats = asyncHandler(async (req, res) => {
  const workspaceId = req.workspace._id;
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [counts, last30dCount, totalRevenue30d] = await Promise.all([
    Order.aggregate([
      { $match: { workspaceId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Order.countDocuments({ workspaceId, createdAt: { $gte: since30d } }),
    Order.aggregate([
      {
        $match: {
          workspaceId,
          createdAt: { $gte: since30d },
          status: { $in: ["confirmed", "shipped", "delivered"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$subtotal" } } },
    ]),
  ]);
  const statusCounts = counts.reduce(
    (acc, c) => ({ ...acc, [c._id]: c.count }),
    { new: 0, confirmed: 0, shipped: 0, delivered: 0, cancelled: 0 },
  );
  res.json({
    success: true,
    statusCounts,
    last30dCount,
    revenue30d: totalRevenue30d[0]?.total || 0,
  });
});

module.exports = {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  deleteOrder,
  sendOrderMessage,
  getOrderStats,
};
