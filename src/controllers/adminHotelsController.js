/**
 * Admin — hotels, platform stats, and consultant detail.
 *
 * These endpoints back the founder's "everything about every hotel" view. All
 * of them sit behind requireAdmin (mounted in routes/admin.js).
 *
 * Query discipline: the list endpoints NEVER loop a query per row. Each one
 * resolves the page of workspaces first, then runs a small, fixed number of
 * aggregation pipelines ($match { $in: pageIds } → $group) and stitches the
 * results together in memory. Adding hotels changes the size of those
 * aggregates, never their count.
 *
 * Money is never summed across currencies: every total is a
 * [{ currency, amount }] list so IDR and USD stay apart.
 */
const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");

const User = require("../models/User");
const Workspace = require("../models/Workspace");
const Property = require("../models/Property");
const RoomType = require("../models/RoomType");
const HotelBooking = require("../models/HotelBooking");
const Guest = require("../models/Guest");
const Consultant = require("../models/Consultant");
const CommissionEntry = require("../models/CommissionEntry");
const TransferBooking = require("../models/TransferBooking");
const Review = require("../models/Review");
const Upsell = require("../models/Upsell");
const Conversation = require("../models/Conversation");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

/** Start of the current calendar month (server time). */
const monthStart = (d = new Date()) =>
  new Date(d.getFullYear(), d.getMonth(), 1);

/** "YYYY-MM" bucket used by the commission ledger. */
const periodKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** OTA sources — everything else is bot-closed / direct. */
const OTA_SOURCES = [
  "booking_com",
  "airbnb",
  "agoda",
  "expedia",
  "vrbo",
  "traveloka",
  "tiket",
  "trip_com",
  "hostelworld",
  "google_hotel",
  "other_ota",
];

/** Bookings that represent real revenue (not cancelled / no-show). */
const LIVE_BOOKING_STATUSES = ["pending", "confirmed", "completed"];

/**
 * Fold [{ _id: { ...key, currency }, total }] rows into
 * { key: [{ currency, amount }] }. Currencies stay separate by design.
 */
function foldByCurrency(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const cur = row._id?.currency || "USD";
    out[key] = out[key] || {};
    out[key][cur] = (out[key][cur] || 0) + (row.total || 0);
  }
  const shaped = {};
  for (const [k, byCur] of Object.entries(out)) {
    shaped[k] = Object.entries(byCur).map(([currency, amount]) => ({
      currency,
      amount: round2(amount),
    }));
  }
  return shaped;
}

/** Flatten a currency map object into the same [{currency, amount}] shape. */
const currencyList = (byCur) =>
  Object.entries(byCur || {}).map(([currency, amount]) => ({
    currency,
    amount: round2(amount),
  }));

/** Channels a workspace actually has connected (Instagram lives apart). */
function connectedChannels(ws) {
  const out = [];
  if (ws?.instagram?.status === "connected") {
    out.push({
      platform: "instagram",
      status: "connected",
      handle: ws.instagram.username || null,
    });
  }
  for (const c of ws?.channels || []) {
    out.push({
      platform: c.platform,
      status: c.status,
      provider: c.provider || null,
      handle: c.username || c.phoneNumber || c.displayName || null,
      connectedAt: c.connectedAt || null,
      lastWebhookAt: c.lastWebhookAt || null,
      error: c.webhookError || null,
    });
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * GET /api/admin/hotels
 * One row per workspace that has a property.
 * ?search= &plan= &status= &page= &limit=
 * ──────────────────────────────────────────────────────────────────────── */
const listHotels = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const search = String(req.query.search || "").trim();
  const plan = String(req.query.plan || "").trim();
  const status = String(req.query.status || "").trim();

  // 1) Which workspaces have a property at all? (one distinct query)
  const propertyWorkspaceIds = await Property.distinct("workspaceId");
  if (!propertyWorkspaceIds.length) {
    return res.json({ hotels: [], total: 0, page, limit, pages: 0 });
  }

  const wsFilter = { _id: { $in: propertyWorkspaceIds } };
  if (plan) wsFilter["subscription.plan"] = plan;
  if (status) wsFilter["subscription.status"] = status;

  // Search spans workspace name, owner name/email and property name/city, so
  // resolve the id sets for the non-workspace fields up front (2 queries) and
  // fold them into a single $or.
  if (search) {
    const rx = { $regex: search, $options: "i" };
    const [ownerIds, propWsIds] = await Promise.all([
      User.distinct("_id", { $or: [{ name: rx }, { email: rx }] }),
      Property.distinct("workspaceId", {
        $or: [{ name: rx }, { city: rx }, { country: rx }],
      }),
    ]);
    wsFilter.$or = [
      { name: rx },
      { owner: { $in: ownerIds } },
      { _id: { $in: propWsIds } },
    ];
  }

  const [total, workspaces] = await Promise.all([
    Workspace.countDocuments(wsFilter),
    Workspace.find(wsFilter)
      .select(
        "name slug owner subscription instagram channels acquisition createdAt updatedAt aiSettings.enabled aiStats usage",
      )
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  if (!workspaces.length) {
    return res.json({
      hotels: [],
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  }

  const ids = workspaces.map((w) => w._id);
  const ownerIds = workspaces.map((w) => w.owner).filter(Boolean);
  const consultantIds = workspaces
    .map((w) => w.acquisition?.consultantId)
    .filter(Boolean);

  const mStart = monthStart();
  const period = periodKey();

  // 2) A fixed set of aggregates over the CURRENT PAGE only. No per-row query.
  const [
    owners,
    properties,
    roomAgg,
    bookingAgg,
    monthBookingAgg,
    commissionAgg,
    consultants,
    lastConvAgg,
  ] = await Promise.all([
    User.find({ _id: { $in: ownerIds } })
      .select("name email createdAt lastLogin isEmailVerified")
      .lean(),
    Property.find({ workspaceId: { $in: ids } })
      .select(
        "workspaceId name city country currency propertyType channel.provider channel.status channel.connectedOtas channel.requestedOtas channel.lastSyncAt starRating active createdAt",
      )
      .lean(),
    RoomType.aggregate([
      { $match: { workspaceId: { $in: ids }, active: { $ne: false } } },
      {
        $group: {
          _id: "$workspaceId",
          roomTypes: { $sum: 1 },
          units: { $sum: { $ifNull: ["$unitsCount", 1] } },
        },
      },
    ]),
    HotelBooking.aggregate([
      { $match: { workspaceId: { $in: ids } } },
      { $group: { _id: "$workspaceId", total: { $sum: 1 } } },
    ]),
    HotelBooking.aggregate([
      {
        $match: {
          workspaceId: { $in: ids },
          createdAt: { $gte: mStart },
          status: { $in: LIVE_BOOKING_STATUSES },
        },
      },
      {
        $group: {
          _id: { workspaceId: "$workspaceId", currency: "$currency" },
          total: { $sum: { $ifNull: ["$totalAmount", 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
    CommissionEntry.aggregate([
      {
        $match: {
          workspaceId: { $in: ids },
          kind: "platform_revenue",
          period,
          status: { $ne: "void" },
        },
      },
      {
        $group: {
          _id: { workspaceId: "$workspaceId", currency: "$currency" },
          total: { $sum: "$amount" },
        },
      },
    ]),
    Consultant.find({ _id: { $in: consultantIds } })
      .select("fullName code status")
      .lean(),
    Conversation.aggregate([
      { $match: { workspaceId: { $in: ids } } },
      { $group: { _id: "$workspaceId", lastMessageAt: { $max: "$lastMessageAt" } } },
    ]),
  ]);

  // 3) Index everything by workspace id, then map the rows.
  const ownerById = new Map(owners.map((u) => [String(u._id), u]));
  const propByWs = new Map();
  for (const p of properties) {
    const k = String(p.workspaceId);
    // Keep the primary (first-created active) property for the row summary.
    const cur = propByWs.get(k);
    if (!cur || (cur.active === false && p.active !== false)) propByWs.set(k, p);
  }
  const propCountByWs = properties.reduce((acc, p) => {
    const k = String(p.workspaceId);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  const roomsByWs = new Map(roomAgg.map((r) => [String(r._id), r]));
  const bookingsByWs = new Map(bookingAgg.map((r) => [String(r._id), r.total]));
  const consultantById = new Map(consultants.map((c) => [String(c._id), c]));
  const lastConvByWs = new Map(
    lastConvAgg.map((r) => [String(r._id), r.lastMessageAt]),
  );

  const revenueByWs = foldByCurrency(monthBookingAgg, (r) =>
    String(r._id.workspaceId),
  );
  const commissionByWs = foldByCurrency(commissionAgg, (r) =>
    String(r._id.workspaceId),
  );
  const monthCountByWs = monthBookingAgg.reduce((acc, r) => {
    const k = String(r._id.workspaceId);
    acc[k] = (acc[k] || 0) + r.count;
    return acc;
  }, {});

  const hotels = workspaces.map((w) => {
    const k = String(w._id);
    const owner = ownerById.get(String(w.owner)) || null;
    const prop = propByWs.get(k) || null;
    const rooms = roomsByWs.get(k) || { roomTypes: 0, units: 0 };
    const consultant = w.acquisition?.consultantId
      ? consultantById.get(String(w.acquisition.consultantId))
      : null;
    const channels = connectedChannels(w);
    const lastConv = lastConvByWs.get(k) || null;

    return {
      workspaceId: w._id,
      workspaceName: w.name,
      slug: w.slug || null,
      owner: owner
        ? {
            id: owner._id,
            name: owner.name,
            email: owner.email,
            verified: !!owner.isEmailVerified,
            lastLogin: owner.lastLogin || null,
          }
        : null,
      signedUpAt: w.createdAt,
      plan: w.subscription?.plan || "free",
      subscriptionStatus: w.subscription?.status || null,
      lifetime: w.subscription?.lifetime === true,
      trialEndsAt: w.subscription?.trialEndsAt || null,
      currentPeriodEnd: w.subscription?.currentPeriodEnd || null,
      property: prop
        ? {
            id: prop._id,
            name: prop.name,
            city: prop.city || "",
            country: prop.country || "",
            currency: prop.currency || "USD",
            type: prop.propertyType || "hotel",
            starRating: prop.starRating || 0,
            active: prop.active !== false,
          }
        : null,
      propertyCount: propCountByWs[k] || 0,
      rooms: { types: rooms.roomTypes || 0, units: rooms.units || 0 },
      channel: {
        provider: prop?.channel?.provider || "none",
        status: prop?.channel?.status || "disconnected",
        connectedOtas: prop?.channel?.connectedOtas || [],
        requestedOtas: prop?.channel?.requestedOtas || [],
        lastSyncAt: prop?.channel?.lastSyncAt || null,
      },
      messagingChannels: channels,
      bookings: {
        total: bookingsByWs.get(k) || 0,
        thisMonth: monthCountByWs[k] || 0,
      },
      revenueThisMonth: revenueByWs[k] || [],
      commissionThisMonth: commissionByWs[k] || [],
      consultant: consultant
        ? {
            id: consultant._id,
            name: consultant.fullName || "",
            code: consultant.code,
            status: consultant.status,
            attributedAt: w.acquisition?.attributedAt || null,
          }
        : null,
      aiEnabled: w.aiSettings?.enabled !== false,
      lastActivityAt:
        [lastConv, w.instagram?.lastMessageAt, w.updatedAt]
          .filter(Boolean)
          .map((d) => new Date(d))
          .sort((a, b) => b - a)[0] || null,
    };
  });

  res.json({
    hotels,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    period,
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * GET /api/admin/hotels/:workspaceId — full detail for one hotel.
 * ──────────────────────────────────────────────────────────────────────── */
const getHotel = asyncHandler(async (req, res) => {
  const { workspaceId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(workspaceId)) {
    res.status(400);
    throw new Error("Invalid workspace id");
  }
  const wsId = oid(workspaceId);

  const workspace = await Workspace.findById(wsId)
    .select("-aiKnowledge.sources.content")
    .lean();
  if (!workspace) {
    res.status(404);
    throw new Error("Workspace not found");
  }

  const mStart = monthStart();
  const period = periodKey();
  const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [
    owner,
    properties,
    roomTypes,
    recentBookings,
    bookingTotals,
    monthBookingAgg,
    sourceAgg,
    guestCount,
    ledger,
    commissionAgg,
    transfersCount,
    reviewAgg,
    upsellAgg,
    consultant,
    conversationCount,
    lastConv,
  ] = await Promise.all([
    workspace.owner
      ? User.findById(workspace.owner)
          .select("name email createdAt lastLogin isEmailVerified signupNumber googleId")
          .lean()
      : null,
    Property.find({ workspaceId: wsId }).lean(),
    RoomType.find({ workspaceId: wsId }).sort({ createdAt: 1 }).lean(),
    HotelBooking.find({ workspaceId: wsId })
      .select(
        "code guestName guestEmail guestPhone checkIn checkOut nights unitsBooked nightlyRate totalAmount currency source status commission payment roomTypeId createdAt",
      )
      .sort({ createdAt: -1 })
      .limit(25)
      .lean(),
    HotelBooking.aggregate([
      { $match: { workspaceId: wsId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    HotelBooking.aggregate([
      {
        $match: {
          workspaceId: wsId,
          createdAt: { $gte: mStart },
          status: { $in: LIVE_BOOKING_STATUSES },
        },
      },
      {
        $group: {
          _id: { currency: "$currency" },
          total: { $sum: { $ifNull: ["$totalAmount", 0] } },
          count: { $sum: 1 },
        },
      },
    ]),
    // Revenue by source over the last 90 days, currency-separated.
    HotelBooking.aggregate([
      {
        $match: {
          workspaceId: wsId,
          createdAt: { $gte: since90 },
          status: { $in: LIVE_BOOKING_STATUSES },
        },
      },
      {
        $group: {
          _id: { source: "$source", currency: "$currency" },
          total: { $sum: { $ifNull: ["$totalAmount", 0] } },
          count: { $sum: 1 },
          nights: { $sum: { $ifNull: ["$nights", 0] } },
        },
      },
      { $sort: { total: -1 } },
    ]),
    Guest.countDocuments({ workspaceId: wsId }),
    CommissionEntry.find({ workspaceId: wsId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("consultantId", "fullName code")
      .lean(),
    CommissionEntry.aggregate([
      { $match: { workspaceId: wsId, status: { $ne: "void" } } },
      {
        $group: {
          _id: {
            kind: "$kind",
            revenueType: "$revenueType",
            status: "$status",
            currency: "$currency",
          },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    TransferBooking.countDocuments({ workspaceId: wsId }),
    Review.aggregate([
      { $match: { workspaceId: wsId } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avgStars: { $avg: "$stars" },
          avgRating: { $avg: "$rating" },
        },
      },
    ]),
    Upsell.aggregate([
      { $match: { workspaceId: wsId } },
      {
        $group: {
          _id: { status: "$status", currency: "$currency" },
          total: {
            $sum: {
              $multiply: [
                { $ifNull: ["$price", 0] },
                { $ifNull: ["$quantity", 1] },
              ],
            },
          },
          count: { $sum: 1 },
        },
      },
    ]),
    workspace.acquisition?.consultantId
      ? Consultant.findById(workspace.acquisition.consultantId)
          .select("fullName code status phone city country payout totals")
          .lean()
      : null,
    Conversation.countDocuments({ workspaceId: wsId }),
    Conversation.findOne({ workspaceId: wsId })
      .sort({ lastMessageAt: -1 })
      .select("lastMessageAt")
      .lean(),
  ]);

  // Room type names for the bookings table (one lookup, from the list we have).
  const roomNameById = new Map(
    roomTypes.map((r) => [String(r._id), r.name]),
  );

  const primary =
    properties.find((p) => p.active !== false) || properties[0] || null;

  // Bookings totals per status.
  const bookingsByStatus = bookingTotals.reduce((acc, r) => {
    acc[r._id || "unknown"] = r.count;
    return acc;
  }, {});
  const totalBookings = bookingTotals.reduce((a, r) => a + r.count, 0);

  // Revenue by source (90d) — grouped source → per-currency amounts.
  const bySource = {};
  for (const r of sourceAgg) {
    const src = r._id.source;
    bySource[src] = bySource[src] || {
      source: src,
      isOta: OTA_SOURCES.includes(src),
      count: 0,
      nights: 0,
      byCurrency: {},
    };
    bySource[src].count += r.count;
    bySource[src].nights += r.nights || 0;
    const cur = r._id.currency || "USD";
    bySource[src].byCurrency[cur] =
      (bySource[src].byCurrency[cur] || 0) + r.total;
  }
  const revenueBySource = Object.values(bySource)
    .map((s) => ({
      source: s.source,
      isOta: s.isOta,
      bookings: s.count,
      nights: s.nights,
      revenue: currencyList(s.byCurrency),
    }))
    .sort((a, b) => b.bookings - a.bookings);

  // Commission totals: platform revenue vs consultant share, by status.
  const commissionTotals = { platform: {}, consultant: {} };
  for (const r of commissionAgg) {
    const bucket =
      r._id.kind === "consultant_share" ? "consultant" : "platform";
    const status = r._id.status || "accrued";
    const cur = r._id.currency || "USD";
    commissionTotals[bucket][status] = commissionTotals[bucket][status] || {};
    commissionTotals[bucket][status][cur] =
      (commissionTotals[bucket][status][cur] || 0) + r.total;
  }
  const shapeCommission = (obj) =>
    Object.entries(obj).map(([status, byCur]) => ({
      status,
      amounts: currencyList(byCur),
    }));

  const upsells = {
    offered: 0,
    accepted: 0,
    declined: 0,
    acceptedValue: {},
  };
  for (const r of upsellAgg) {
    const st = r._id.status;
    if (st in upsells) upsells[st] += r.count;
    if (st === "accepted") {
      const cur = r._id.currency || "USD";
      upsells.acceptedValue[cur] = (upsells.acceptedValue[cur] || 0) + r.total;
    }
  }

  const reviews = reviewAgg[0] || { count: 0, avgStars: null, avgRating: null };

  res.json({
    workspace: {
      id: workspace._id,
      name: workspace.name,
      slug: workspace.slug || null,
      createdAt: workspace.createdAt,
      onboardingCompleted: !!workspace.onboardingCompleted,
      lastActivityAt: lastConv?.lastMessageAt || workspace.updatedAt || null,
    },
    owner: owner
      ? {
          id: owner._id,
          name: owner.name,
          email: owner.email,
          verified: !!owner.isEmailVerified,
          signupNumber: owner.signupNumber ?? null,
          signupMethod: owner.googleId ? "google" : "email",
          signedUpAt: owner.createdAt,
          lastLogin: owner.lastLogin || null,
        }
      : null,
    subscription: {
      plan: workspace.subscription?.plan || "free",
      status: workspace.subscription?.status || null,
      lifetime: workspace.subscription?.lifetime === true,
      provider: workspace.subscription?.provider || null,
      billingCycle: workspace.subscription?.billingCycle || null,
      trialEndsAt: workspace.subscription?.trialEndsAt || null,
      currentPeriodStart: workspace.subscription?.currentPeriodStart || null,
      currentPeriodEnd: workspace.subscription?.currentPeriodEnd || null,
      cancelAtPeriodEnd: !!workspace.subscription?.cancelAtPeriodEnd,
    },
    // Full property records (address, policies, rules, payment methods…).
    properties: properties.map((p) => ({
      id: p._id,
      name: p.name,
      propertyType: p.propertyType,
      description: p.description || "",
      address: p.address || "",
      city: p.city || "",
      state: p.state || "",
      country: p.country || "",
      zipCode: p.zipCode || "",
      timezone: p.timezone || "",
      currency: p.currency || "USD",
      starRating: p.starRating || 0,
      phone: p.phone || "",
      email: p.email || "",
      checkInTime: p.checkInTime || "",
      checkOutTime: p.checkOutTime || "",
      policies: p.policies || "",
      rules: p.rules || {},
      paymentMethods: p.paymentMethods || {},
      amenities: p.amenities || [],
      photoCount: (p.photos || []).length,
      channel: {
        provider: p.channel?.provider || "none",
        status: p.channel?.status || "disconnected",
        connectedOtas: p.channel?.connectedOtas || [],
        requestedOtas: p.channel?.requestedOtas || [],
        lastSyncAt: p.channel?.lastSyncAt || null,
        lastError: p.channel?.lastError || null,
        icalCount: (p.channel?.icalImportUrls || []).length,
      },
      transfers: p.transfers || {},
      upsellCatalog: (p.upsells || []).map((u) => ({
        key: u.key,
        label: u.label,
        price: u.price,
        enabled: u.enabled !== false,
      })),
      directBooking: {
        enabled: p.directBooking?.enabled !== false,
        slug: p.directBooking?.slug || null,
      },
      revenue: p.revenue || {},
      active: p.active !== false,
      createdAt: p.createdAt,
    })),
    primaryPropertyId: primary?._id || null,
    roomTypes: roomTypes.map((r) => ({
      id: r._id,
      propertyId: r.propertyId,
      name: r.name,
      unitsCount: r.unitsCount || 1,
      maxAdults: r.maxAdults,
      maxChildren: r.maxChildren,
      maxOccupancy: r.maxOccupancy,
      baseOccupancy: r.baseOccupancy,
      extraGuestFee: r.extraGuestFee || 0,
      bedConfig: r.bedConfig || "",
      sizeSqm: r.sizeSqm || null,
      baseRate: r.baseRate || 0,
      currency: r.currency || "USD",
      breakfast: r.breakfast || {},
      cancellation: r.cancellation || {},
      bathroom: r.bathroom || "",
      channexRoomTypeId: r.channexRoomTypeId || null,
      housekeeping: (r.units || []).reduce((acc, u) => {
        const s = u.housekeeping || "clean";
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, {}),
      active: r.active !== false,
    })),
    rooms: {
      types: roomTypes.filter((r) => r.active !== false).length,
      units: roomTypes
        .filter((r) => r.active !== false)
        .reduce((a, r) => a + (r.unitsCount || 1), 0),
    },
    bookings: {
      total: totalBookings,
      byStatus: bookingsByStatus,
      thisMonth: monthBookingAgg.reduce((a, r) => a + r.count, 0),
      revenueThisMonth: currencyList(
        monthBookingAgg.reduce((acc, r) => {
          const cur = r._id.currency || "USD";
          acc[cur] = (acc[cur] || 0) + r.total;
          return acc;
        }, {}),
      ),
      recent: recentBookings.map((b) => ({
        id: b._id,
        code: b.code,
        guestName: b.guestName || "",
        guestEmail: b.guestEmail || "",
        guestPhone: b.guestPhone || "",
        roomType: roomNameById.get(String(b.roomTypeId)) || "—",
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        nights: b.nights,
        units: b.unitsBooked || 1,
        amount: b.totalAmount || 0,
        currency: b.currency || "USD",
        source: b.source,
        isOta: OTA_SOURCES.includes(b.source),
        status: b.status,
        commission: {
          rate: b.commission?.rate || 0,
          amount: b.commission?.amount || 0,
          currency: b.commission?.currency || b.currency || "USD",
        },
        paymentStatus: b.payment?.status || "unpaid",
        createdAt: b.createdAt,
      })),
    },
    revenueBySource90d: revenueBySource,
    guests: { total: guestCount },
    conversations: { total: conversationCount },
    channels: connectedChannels(workspace),
    commissions: {
      period,
      platform: shapeCommission(commissionTotals.platform),
      consultantShare: shapeCommission(commissionTotals.consultant),
      ledger: ledger.map((e) => ({
        id: e._id,
        kind: e.kind,
        revenueType: e.revenueType,
        amount: e.amount,
        currency: e.currency || "USD",
        sourceAmount: e.sourceAmount ?? null,
        sourceCurrency: e.sourceCurrency || null,
        rate: e.rate ?? null,
        period: e.period || null,
        status: e.status,
        reference: e.reference || "",
        consultant: e.consultantId
          ? { name: e.consultantId.fullName, code: e.consultantId.code }
          : null,
        createdAt: e.createdAt,
        paidAt: e.paidAt || null,
      })),
    },
    consultant: consultant
      ? {
          id: consultant._id,
          name: consultant.fullName || "",
          code: consultant.code,
          status: consultant.status,
          phone: consultant.phone || "",
          location: [consultant.city, consultant.country]
            .filter(Boolean)
            .join(", "),
          attributedAt: workspace.acquisition?.attributedAt || null,
        }
      : null,
    transfers: { total: transfersCount },
    reviews: {
      total: reviews.count || 0,
      avgStars: reviews.avgStars ? round2(reviews.avgStars) : null,
      avgRating: reviews.avgRating ? round2(reviews.avgRating) : null,
    },
    upsells: {
      offered: upsells.offered,
      accepted: upsells.accepted,
      declined: upsells.declined,
      acceptedValue: currencyList(upsells.acceptedValue),
    },
    ai: {
      enabled: workspace.aiSettings?.enabled !== false,
      provider: workspace.aiSettings?.provider || null,
      model: workspace.aiSettings?.model || null,
      aiRole: workspace.aiSettings?.aiRole || "",
      brandVoice: workspace.aiSettings?.brandVoice || "",
      guardrails: workspace.aiSettings?.guardrails || "",
      goals: workspace.aiSettings?.goals || [],
      matchLanguage: workspace.aiSettings?.matchLanguage !== false,
      faqCount: (workspace.aiSettings?.faqs || []).length,
      knowledgeEnabled: workspace.aiKnowledge?.enabled !== false,
      knowledgeSources: (workspace.aiKnowledge?.sources || []).length,
      repliesThisMonth: workspace.aiStats?.repliesThisMonth || 0,
      leadsCaptured: workspace.aiStats?.leadsCaptured || 0,
      messagesThisMonth: workspace.usage?.messagesThisMonth || 0,
    },
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * GET /api/admin/stats — platform-wide numbers for the Overview tab.
 * ──────────────────────────────────────────────────────────────────────── */
const platformStats = asyncHandler(async (req, res) => {
  const now = new Date();
  const mStart = monthStart(now);
  const period = periodKey(now);
  const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const hotelWorkspaceIds = await Property.distinct("workspaceId");

  const [
    totalProperties,
    roomAgg,
    planAgg,
    bookingSourceAgg,
    commissionAgg,
    consultantAgg,
    topRevenueAgg,
    newSignups,
    newHotels,
  ] = await Promise.all([
    Property.countDocuments(),
    RoomType.aggregate([
      { $match: { active: { $ne: false } } },
      {
        $group: {
          _id: null,
          types: { $sum: 1 },
          units: { $sum: { $ifNull: ["$unitsCount", 1] } },
        },
      },
    ]),
    Workspace.aggregate([
      { $match: { _id: { $in: hotelWorkspaceIds } } },
      {
        $group: {
          _id: {
            plan: "$subscription.plan",
            status: "$subscription.status",
            lifetime: "$subscription.lifetime",
          },
          count: { $sum: 1 },
        },
      },
    ]),
    HotelBooking.aggregate([
      {
        $match: {
          createdAt: { $gte: mStart },
          status: { $in: LIVE_BOOKING_STATUSES },
        },
      },
      {
        $group: {
          _id: { source: "$source", currency: "$currency" },
          count: { $sum: 1 },
          total: { $sum: { $ifNull: ["$totalAmount", 0] } },
        },
      },
    ]),
    CommissionEntry.aggregate([
      { $match: { period, status: { $ne: "void" } } },
      {
        $group: {
          _id: { kind: "$kind", status: "$status", currency: "$currency" },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    Consultant.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    HotelBooking.aggregate([
      {
        $match: {
          createdAt: { $gte: mStart },
          status: { $in: LIVE_BOOKING_STATUSES },
        },
      },
      {
        $group: {
          _id: { workspaceId: "$workspaceId", currency: "$currency" },
          total: { $sum: { $ifNull: ["$totalAmount", 0] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 25 },
    ]),
    User.countDocuments({ createdAt: { $gte: since30 } }),
    Workspace.countDocuments({
      _id: { $in: hotelWorkspaceIds },
      createdAt: { $gte: since30 },
    }),
  ]);

  // Plan / status breakdown across hotel workspaces.
  const plans = {};
  let active = 0;
  let trialing = 0;
  let free = 0;
  let lifetime = 0;
  let cancelled = 0;
  for (const r of planAgg) {
    const plan = r._id.plan || "free";
    plans[plan] = (plans[plan] || 0) + r.count;
    if (r._id.lifetime === true) lifetime += r.count;
    else if (r._id.status === "active" && plan !== "free") active += r.count;
    else if (r._id.status === "trialing") trialing += r.count;
    else if (["cancelled", "past_due", "suspended"].includes(r._id.status))
      cancelled += r.count;
    else free += r.count;
  }

  // Bookings + GMV this month by source (currency-separated).
  const sourceMap = {};
  const gmvByCurrency = {};
  let bookingsThisMonth = 0;
  for (const r of bookingSourceAgg) {
    const src = r._id.source;
    const cur = r._id.currency || "USD";
    sourceMap[src] = sourceMap[src] || {
      source: src,
      isOta: OTA_SOURCES.includes(src),
      count: 0,
      byCurrency: {},
    };
    sourceMap[src].count += r.count;
    sourceMap[src].byCurrency[cur] =
      (sourceMap[src].byCurrency[cur] || 0) + r.total;
    gmvByCurrency[cur] = (gmvByCurrency[cur] || 0) + r.total;
    bookingsThisMonth += r.count;
  }
  const bookingsBySource = Object.values(sourceMap)
    .map((s) => ({
      source: s.source,
      isOta: s.isOta,
      bookings: s.count,
      gmv: currencyList(s.byCurrency),
    }))
    .sort((a, b) => b.bookings - a.bookings);

  // Commission buckets this period.
  const platformByStatus = {};
  const consultantByStatus = {};
  for (const r of commissionAgg) {
    const target =
      r._id.kind === "consultant_share" ? consultantByStatus : platformByStatus;
    const st = r._id.status || "accrued";
    const cur = r._id.currency || "USD";
    target[st] = target[st] || {};
    target[st][cur] = (target[st][cur] || 0) + r.total;
  }
  const shape = (obj) =>
    Object.entries(obj).map(([status, byCur]) => ({
      status,
      amounts: currencyList(byCur),
    }));

  // Top 5 hotels by revenue this month — the aggregate returns at most 25
  // (workspace, currency) rows, so the names come from ONE extra find().
  const topIds = [
    ...new Set(topRevenueAgg.map((r) => String(r._id.workspaceId))),
  ].slice(0, 25);
  const topWorkspaces = topIds.length
    ? await Workspace.find({ _id: { $in: topIds.map(oid) } })
        .select("name subscription.plan")
        .lean()
    : [];
  const topProps = topIds.length
    ? await Property.find({ workspaceId: { $in: topIds.map(oid) } })
        .select("workspaceId name city country")
        .lean()
    : [];
  const propByWs = new Map(topProps.map((p) => [String(p.workspaceId), p]));
  const wsById = new Map(topWorkspaces.map((w) => [String(w._id), w]));

  const topAgg = {};
  for (const r of topRevenueAgg) {
    const k = String(r._id.workspaceId);
    topAgg[k] = topAgg[k] || { bookings: 0, byCurrency: {}, max: 0 };
    topAgg[k].bookings += r.count;
    const cur = r._id.currency || "USD";
    topAgg[k].byCurrency[cur] = (topAgg[k].byCurrency[cur] || 0) + r.total;
    topAgg[k].max = Math.max(topAgg[k].max, topAgg[k].byCurrency[cur]);
  }
  const topHotels = Object.entries(topAgg)
    .sort((a, b) => b[1].max - a[1].max)
    .slice(0, 5)
    .map(([k, v]) => {
      const w = wsById.get(k);
      const p = propByWs.get(k);
      return {
        workspaceId: k,
        name: p?.name || w?.name || "—",
        workspaceName: w?.name || "",
        location: [p?.city, p?.country].filter(Boolean).join(", "),
        plan: w?.subscription?.plan || "free",
        bookings: v.bookings,
        revenue: currencyList(v.byCurrency),
      };
    });

  const consultantCounts = consultantAgg.reduce(
    (acc, r) => {
      acc[r._id || "pending"] = r.count;
      acc.total += r.count;
      return acc;
    },
    { total: 0 },
  );

  const rooms = roomAgg[0] || { types: 0, units: 0 };

  res.json({
    period,
    hotels: {
      total: hotelWorkspaceIds.length,
      active,
      trialing,
      free,
      lifetime,
      cancelled,
      newLast30d: newHotels,
      byPlan: Object.entries(plans).map(([plan, count]) => ({ plan, count })),
    },
    properties: { total: totalProperties },
    rooms: { types: rooms.types || 0, units: rooms.units || 0 },
    bookingsThisMonth: {
      total: bookingsThisMonth,
      bySource: bookingsBySource,
      gmv: currencyList(gmvByCurrency),
    },
    commissionsThisMonth: {
      platform: shape(platformByStatus),
      consultantShare: shape(consultantByStatus),
    },
    consultants: {
      total: consultantCounts.total,
      approved: consultantCounts.approved || 0,
      pending: consultantCounts.pending || 0,
      suspended: consultantCounts.suspended || 0,
    },
    topHotels,
    newSignupsLast30d: newSignups,
    generatedAt: now,
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * GET /api/admin/consultants/:id — full consultant detail.
 * ──────────────────────────────────────────────────────────────────────── */
const getConsultant = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400);
    throw new Error("Invalid consultant id");
  }
  const consultantId = oid(id);

  const consultant = await Consultant.findById(consultantId)
    .populate("userId", "name email createdAt lastLogin")
    .lean();
  if (!consultant) {
    res.status(404);
    throw new Error("Consultant not found");
  }

  const workspaces = await Workspace.find({
    "acquisition.consultantId": consultantId,
  })
    .select("name owner subscription acquisition createdAt")
    .lean();
  const wsIds = workspaces.map((w) => w._id);

  const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [properties, owners, revenueAgg, shareAgg, ledger] = await Promise.all([
    wsIds.length
      ? Property.find({ workspaceId: { $in: wsIds } })
          .select("workspaceId name city country")
          .lean()
      : [],
    Promise.resolve(workspaces.map((w) => w.owner).filter(Boolean)).then((o) =>
      o.length
        ? User.find({ _id: { $in: o } }).select("name email").lean()
        : [],
    ),
    // Hotel revenue (90d) per attributed workspace — one aggregate.
    wsIds.length
      ? HotelBooking.aggregate([
          {
            $match: {
              workspaceId: { $in: wsIds },
              createdAt: { $gte: since90 },
              status: { $in: LIVE_BOOKING_STATUSES },
            },
          },
          {
            $group: {
              _id: { workspaceId: "$workspaceId", currency: "$currency" },
              total: { $sum: { $ifNull: ["$totalAmount", 0] } },
              count: { $sum: 1 },
            },
          },
        ])
      : [],
    // This consultant's share per workspace + status — one aggregate.
    CommissionEntry.aggregate([
      { $match: { consultantId, kind: "consultant_share" } },
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            status: "$status",
            currency: "$currency",
          },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
          lastPaidAt: { $max: "$paidAt" },
        },
      },
    ]),
    CommissionEntry.find({ consultantId })
      .sort({ createdAt: -1 })
      .limit(300)
      .populate("workspaceId", "name")
      .lean(),
  ]);

  const propByWs = new Map(properties.map((p) => [String(p.workspaceId), p]));
  const ownerById = new Map(owners.map((u) => [String(u._id), u]));

  const revenueByWs = {};
  const bookingsByWs = {};
  for (const r of revenueAgg) {
    const k = String(r._id.workspaceId);
    revenueByWs[k] = revenueByWs[k] || {};
    const cur = r._id.currency || "USD";
    revenueByWs[k][cur] = (revenueByWs[k][cur] || 0) + r.total;
    bookingsByWs[k] = (bookingsByWs[k] || 0) + r.count;
  }

  const shareByWs = {};
  const totalsByStatus = {};
  let lastPayoutAt = null;
  for (const r of shareAgg) {
    const k = String(r._id.workspaceId);
    const st = r._id.status || "accrued";
    const cur = r._id.currency || "USD";
    shareByWs[k] = shareByWs[k] || {};
    shareByWs[k][st] = shareByWs[k][st] || {};
    shareByWs[k][st][cur] = (shareByWs[k][st][cur] || 0) + r.total;
    totalsByStatus[st] = totalsByStatus[st] || {};
    totalsByStatus[st][cur] = (totalsByStatus[st][cur] || 0) + r.total;
    if (r.lastPaidAt && (!lastPayoutAt || r.lastPaidAt > lastPayoutAt))
      lastPayoutAt = r.lastPaidAt;
  }

  const shareRate = Number(process.env.CONSULTANT_REVENUE_SHARE_RATE || 0.2);

  const hotels = workspaces.map((w) => {
    const k = String(w._id);
    const p = propByWs.get(k);
    const owner = ownerById.get(String(w.owner));
    const rev = revenueByWs[k] || {};
    return {
      workspaceId: w._id,
      workspaceName: w.name,
      propertyName: p?.name || null,
      location: [p?.city, p?.country].filter(Boolean).join(", "),
      owner: owner ? { name: owner.name, email: owner.email } : null,
      plan: w.subscription?.plan || "free",
      subscriptionStatus: w.subscription?.status || null,
      signedUpAt: w.createdAt,
      attributedAt: w.acquisition?.attributedAt || null,
      revenue90d: currencyList(rev),
      bookings90d: bookingsByWs[k] || 0,
      // What 20% of that hotel revenue would be — indicative, alongside the
      // real ledger numbers below.
      indicativeShare90d: currencyList(
        Object.fromEntries(
          Object.entries(rev).map(([c, a]) => [c, a * shareRate]),
        ),
      ),
      share: Object.entries(shareByWs[k] || {}).map(([status, byCur]) => ({
        status,
        amounts: currencyList(byCur),
      })),
    };
  });

  res.json({
    consultant: {
      id: consultant._id,
      code: consultant.code,
      status: consultant.status,
      fullName: consultant.fullName || "",
      phone: consultant.phone || "",
      city: consultant.city || "",
      country: consultant.country || "",
      user: consultant.userId
        ? {
            id: consultant.userId._id,
            name: consultant.userId.name,
            email: consultant.userId.email,
            joinedAt: consultant.userId.createdAt,
            lastLogin: consultant.userId.lastLogin || null,
          }
        : null,
      payout: consultant.payout || {},
      totals: consultant.totals || {},
      approvedAt: consultant.approvedAt || null,
      approvedBy: consultant.approvedBy || "",
      suspendedReason: consultant.suspendedReason || "",
      createdAt: consultant.createdAt,
    },
    shareRate,
    hotels,
    hotelsSigned: workspaces.length,
    totals: Object.entries(totalsByStatus).map(([status, byCur]) => ({
      status,
      amounts: currencyList(byCur),
    })),
    lastPayoutAt,
    ledger: ledger.map((e) => ({
      id: e._id,
      kind: e.kind,
      revenueType: e.revenueType,
      workspaceName: e.workspaceId?.name || "—",
      workspaceId: e.workspaceId?._id || e.workspaceId || null,
      amount: e.amount,
      currency: e.currency || "USD",
      sourceAmount: e.sourceAmount ?? null,
      sourceCurrency: e.sourceCurrency || null,
      rate: e.rate ?? null,
      period: e.period || null,
      status: e.status,
      reference: e.reference || "",
      payoutReference: e.payoutReference || "",
      createdAt: e.createdAt,
      verifiedAt: e.verifiedAt || null,
      paidAt: e.paidAt || null,
    })),
  });
});

module.exports = {
  listHotels,
  getHotel,
  platformStats,
  getConsultant,
};
