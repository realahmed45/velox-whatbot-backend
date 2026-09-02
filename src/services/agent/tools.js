/**
 * agent/tools.js — what the Botlify Agent can actually DO.
 *
 * Each tool is { name, description, parameters (JSON schema), confirm, run }.
 *  - `confirm: true` means the agent must show the owner a summary and get a
 *    "yes" before running it. Anything that changes money, availability or a
 *    guest-visible fact is confirm:true. Read-only tools run immediately.
 *  - `run(args, ctx)` where ctx = { workspace, property, user }.
 *  - Every run returns a plain object the model can read back to the owner.
 *    Errors are returned as { error: "..." }, never thrown, so one bad tool
 *    call never kills the conversation.
 */
const logger = require("../../utils/logger");

const DAY = 24 * 60 * 60 * 1000;

/** Parse a loose date ("2026-09-12") to UTC midnight. */
function day(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const fmt = (d) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(d);

/** Resolve a room type by name (fuzzy) or id, within this workspace. */
async function findRoom(ctx, nameOrId) {
  const RoomType = require("../../models/RoomType");
  if (!nameOrId) {
    const all = await RoomType.find({
      workspaceId: ctx.workspace._id,
      active: true,
    });
    return all.length === 1 ? all[0] : null;
  }
  if (/^[0-9a-f]{24}$/i.test(String(nameOrId))) {
    return RoomType.findOne({
      _id: nameOrId,
      workspaceId: ctx.workspace._id,
    });
  }
  const rooms = await RoomType.find({
    workspaceId: ctx.workspace._id,
    active: true,
  });
  const q = String(nameOrId).toLowerCase().trim();
  return (
    rooms.find((r) => r.name.toLowerCase() === q) ||
    rooms.find((r) => r.name.toLowerCase().includes(q)) ||
    null
  );
}

const TOOLS = [
  // ── Read-only ────────────────────────────────────────────────────────────
  {
    name: "get_arrivals",
    description:
      "List guests checking in or out on a given date (default today). Use for 'who is arriving today', 'departures tomorrow'.",
    confirm: false,
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        type: {
          type: "string",
          enum: ["arrivals", "departures", "both"],
          description: "defaults to both",
        },
      },
    },
    async run(args, ctx) {
      const HotelBooking = require("../../models/HotelBooking");
      const d = day(args.date) || day(new Date());
      const kind = args.type || "both";
      const base = {
        workspaceId: ctx.workspace._id,
        status: { $in: ["pending", "confirmed"] },
      };
      const out = {};
      if (kind !== "departures") {
        out.arrivals = await HotelBooking.find({ ...base, checkIn: d })
          .select("code guestName guestPhone nights unitsBooked source unitLabel roomTypeId")
          .populate("roomTypeId", "name")
          .lean();
      }
      if (kind !== "arrivals") {
        out.departures = await HotelBooking.find({ ...base, checkOut: d })
          .select("code guestName unitLabel roomTypeId")
          .populate("roomTypeId", "name")
          .lean();
      }
      out.date = fmt(d);
      return out;
    },
  },
  {
    name: "get_occupancy",
    description:
      "Occupancy and unsold rooms for a date range. Use for 'how full are we', 'what does next week look like'.",
    confirm: false,
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        days: { type: "number", description: "how many days, default 7" },
      },
    },
    async run(args, ctx) {
      const RoomType = require("../../models/RoomType");
      const { nightlyAvailability } = require("../hotel/availability");
      const from = day(args.from) || day(new Date());
      const days = Math.min(60, Math.max(1, Number(args.days) || 7));
      const rooms = await RoomType.find({
        workspaceId: ctx.workspace._id,
        active: true,
      });
      const nights = {};
      for (const rt of rooms) {
        const list = await nightlyAvailability(rt, from, days);
        list.forEach((n) => {
          const k = n.date.toISOString().slice(0, 10);
          nights[k] = nights[k] || { date: fmt(n.date), units: 0, free: 0 };
          nights[k].units += rt.unitsCount || 1;
          nights[k].free += n.available;
        });
      }
      const rows = Object.values(nights).map((n) => ({
        ...n,
        occupancyPct: n.units ? Math.round(((n.units - n.free) / n.units) * 100) : 0,
      }));
      return { nights: rows };
    },
  },
  {
    name: "get_revenue",
    description:
      "Revenue and booking counts for a period, split by source. Covers past stays AND future confirmed bookings. Use for 'how did we do last month', 'revenue this week', 'what is booked for next month'.",
    confirm: false,
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        upcoming: {
          type: "boolean",
          description:
            "true to report bookings ahead of today instead of the last 30 days",
        },
      },
    },
    async run(args, ctx) {
      const HotelBooking = require("../../models/HotelBooking");
      // Default window: the last 30 days of stays ("how did we do?"). When the
      // owner asks about what is coming up, look forward instead.
      const today = day(new Date());
      let from = day(args.from);
      let to = day(args.to);
      if (!from && !to) {
        if (args.upcoming) {
          from = today;
          to = new Date(today.getTime() + 30 * DAY);
        } else {
          to = new Date(today.getTime() + DAY);
          from = new Date(to.getTime() - 30 * DAY);
        }
      } else if (!to) {
        to = new Date(from.getTime() + 30 * DAY);
      } else if (!from) {
        from = new Date(to.getTime() - 30 * DAY);
      }
      const rows = await HotelBooking.aggregate([
        {
          $match: {
            workspaceId: ctx.workspace._id,
            status: { $in: ["confirmed", "completed"] },
            checkIn: { $gte: from, $lt: to },
          },
        },
        {
          $group: {
            _id: { source: "$source", currency: "$currency" },
            revenue: { $sum: "$totalAmount" },
            bookings: { $sum: 1 },
            nights: { $sum: "$nights" },
          },
        },
      ]);
      return {
        from: fmt(from),
        to: fmt(to),
        bySource: rows.map((r) => ({
          source: r._id.source,
          currency: r._id.currency,
          revenue: Math.round(r.revenue),
          bookings: r.bookings,
          nights: r.nights,
        })),
      };
    },
  },
  {
    name: "list_bookings",
    description:
      "Search bookings by guest name, booking code, status or date. Use for 'find booking BK-123', 'show cancellations'.",
    confirm: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "guest name or booking code" },
        status: { type: "string", enum: ["pending", "confirmed", "cancelled", "completed", "no_show"] },
        limit: { type: "number" },
      },
    },
    async run(args, ctx) {
      const HotelBooking = require("../../models/HotelBooking");
      const q = { workspaceId: ctx.workspace._id };
      if (args.status) q.status = args.status;
      if (args.query) {
        const rx = new RegExp(String(args.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        q.$or = [{ guestName: rx }, { code: rx }, { guestPhone: rx }];
      }
      const rows = await HotelBooking.find(q)
        .sort({ checkIn: -1 })
        .limit(Math.min(25, Number(args.limit) || 10))
        .select("code guestName checkIn checkOut nights status source totalAmount currency roomTypeId")
        .populate("roomTypeId", "name")
        .lean();
      return {
        bookings: rows.map((b) => ({
          ...b,
          checkIn: fmt(b.checkIn),
          checkOut: fmt(b.checkOut),
        })),
      };
    },
  },
  {
    name: "get_pending_suggestions",
    description:
      "Pricing suggestions waiting for approval. Use for 'any price suggestions', 'what should I change'.",
    confirm: false,
    parameters: { type: "object", properties: {} },
    async run(args, ctx) {
      const RateSuggestion = require("../../models/RateSuggestion");
      const rows = await RateSuggestion.find({
        workspaceId: ctx.workspace._id,
        status: "pending",
      })
        .sort({ dateFrom: 1 })
        .limit(10)
        .populate("roomTypeId", "name")
        .lean();
      return {
        suggestions: rows.map((s) => ({
          id: String(s._id),
          room: s.roomTypeId && s.roomTypeId.name,
          from: fmt(s.dateFrom),
          to: fmt(s.dateTo),
          currentRate: s.currentRate,
          suggestedRate: s.suggestedRate,
          currency: s.currency,
          reason: s.reason,
        })),
      };
    },
  },
  {
    name: "get_reviews",
    description:
      "Recent guest reviews, optionally only ones needing a reply. Use for 'any new reviews', 'what are guests complaining about'.",
    confirm: false,
    parameters: {
      type: "object",
      properties: {
        needsReply: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    async run(args, ctx) {
      const Review = require("../../models/Review");
      const q = { workspaceId: ctx.workspace._id };
      if (args.needsReply) q["reply.status"] = { $in: ["none", "drafted"] };
      const rows = await Review.find(q)
        .sort({ reviewedAt: -1 })
        .limit(Math.min(20, Number(args.limit) || 5))
        .lean();
      return {
        reviews: rows.map((r) => ({
          id: String(r._id),
          guest: r.guestName,
          stars: r.stars,
          text: (r.text || "").slice(0, 300),
          source: r.source,
          sentiment: r.sentiment,
          replyStatus: r.reply && r.reply.status,
          draft: r.reply && r.reply.draft,
        })),
      };
    },
  },
  {
    name: "get_guest",
    description:
      "Look up a guest's history and preferences by name or phone. Use for 'has this guest stayed before', 'tell me about Sarah'.",
    confirm: false,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async run(args, ctx) {
      const Guest = require("../../models/Guest");
      const rx = new RegExp(String(args.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const rows = await Guest.find({
        workspaceId: ctx.workspace._id,
        $or: [{ name: rx }, { phone: rx }, { email: rx }],
      })
        .limit(5)
        .lean();
      return {
        guests: rows.map((g) => ({
          name: g.name,
          phone: g.phone,
          stays: g.stats && g.stats.staysCount,
          nights: g.stats && g.stats.nightsTotal,
          revenue: g.stats && g.stats.revenueTotal,
          lastStay: g.stats && g.stats.lastStayAt ? fmt(new Date(g.stats.lastStayAt)) : null,
          preferences: g.preferences,
          tags: g.tags,
        })),
      };
    },
  },

  // ── Actions (confirm first) ──────────────────────────────────────────────
  {
    name: "set_rate",
    description:
      "Change the nightly rate for a room type, optionally only for a date range. Pushes to Booking.com/Airbnb. Use for 'change Deluxe to 95', 'raise prices next weekend'.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "room type name" },
        rate: { type: "number", description: "new nightly rate" },
        from: { type: "string", description: "YYYY-MM-DD, optional" },
        to: { type: "string", description: "YYYY-MM-DD exclusive, optional" },
      },
      required: ["rate"],
    },
    async run(args, ctx) {
      const Property = require("../../models/Property");
      const rt = await findRoom(ctx, args.room);
      if (!rt) return { error: "I could not find that room type. Which room did you mean?" };
      const rate = Number(args.rate);
      if (!rate || rate <= 0) return { error: "That rate does not look valid." };

      const previous = rt.baseRate;
      rt.baseRate = rate;
      await rt.save();

      let pushed = false;
      let pushError = null;
      const property = await Property.findById(rt.propertyId);
      // Route through the provider abstraction rather than naming Channex: a
      // hardcoded provider meant the rate changed in Botlify while the OTA kept
      // selling the old price on every non-Channex hotel.
      const { getProvider, providerRoomId } = require("../channels");
      const channel = getProvider(property);
      if (
        channel &&
        providerRoomId(property, rt) &&
        typeof channel.pushRateRange === "function"
      ) {
        try {
          const from = day(args.from) || day(new Date());
          const to = day(args.to) || new Date(from.getTime() + 30 * DAY);
          await channel.pushRateRange(property, rt, from, to, rate);
          pushed = true;
        } catch (e) {
          pushError = e.message;
        }
      }
      return {
        room: rt.name,
        previousRate: previous,
        newRate: rate,
        currency: rt.currency,
        pushedToOtas: pushed,
        pushError,
      };
    },
  },
  {
    name: "approve_suggestion",
    description:
      "Approve a pending pricing suggestion by its id (from get_pending_suggestions).",
    confirm: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async run(args, ctx) {
      const { applySuggestion } = require("../revenue/revenueService");
      const res = await applySuggestion(args.id, {
        by: (ctx.user && ctx.user.email) || "agent",
      });
      return res.ok
        ? { applied: true, newRate: res.rate, pushError: res.pushError }
        : { error: "Could not apply that suggestion (" + res.reason + ")." };
    },
  },
  {
    name: "set_housekeeping",
    description:
      "Mark a room unit clean, dirty, inspected or out of service. Use for 'room 101 is clean', 'take villa 2 out of service'.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "room type name" },
        unit: { type: "string", description: "unit label e.g. 101" },
        status: {
          type: "string",
          enum: ["clean", "dirty", "inspected", "out_of_service"],
        },
        note: { type: "string" },
      },
      required: ["unit", "status"],
    },
    async run(args, ctx) {
      const RoomType = require("../../models/RoomType");
      const rooms = await RoomType.find({
        workspaceId: ctx.workspace._id,
        active: true,
      });
      const label = String(args.unit).toLowerCase().trim();
      for (const rt of rooms) {
        const unit = (rt.units || []).find(
          (u) => String(u.label).toLowerCase().trim() === label,
        );
        if (unit) {
          unit.housekeeping = args.status;
          if (args.note !== undefined) unit.note = args.note;
          unit.updatedAt = new Date();
          await rt.save();
          return { unit: unit.label, room: rt.name, status: args.status };
        }
      }
      return { error: "No unit labelled " + args.unit + " was found." };
    },
  },
  {
    name: "check_in_guest",
    description:
      "Check a guest in and assign them a unit. Use for 'check in BK-1234 to room 101'.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "booking code" },
        unit: { type: "string", description: "unit label, optional" },
      },
      required: ["code"],
    },
    async run(args, ctx) {
      const HotelBooking = require("../../models/HotelBooking");
      const b = await HotelBooking.findOne({
        workspaceId: ctx.workspace._id,
        code: new RegExp("^" + String(args.code).trim() + "$", "i"),
      });
      if (!b) return { error: "No booking with code " + args.code + "." };
      if (b.status === "cancelled") return { error: "That booking is cancelled." };
      b.checkedInAt = new Date();
      if (args.unit) b.unitLabel = args.unit;
      await b.save();
      return { code: b.code, guest: b.guestName, unit: b.unitLabel, checkedIn: true };
    },
  },
  {
    name: "check_out_guest",
    description:
      "Check a guest out and mark their unit dirty. Use for 'check out BK-1234'.",
    confirm: true,
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
    async run(args, ctx) {
      const HotelBooking = require("../../models/HotelBooking");
      const RoomType = require("../../models/RoomType");
      const b = await HotelBooking.findOne({
        workspaceId: ctx.workspace._id,
        code: new RegExp("^" + String(args.code).trim() + "$", "i"),
      });
      if (!b) return { error: "No booking with code " + args.code + "." };
      b.checkedOutAt = new Date();
      b.status = "completed";
      await b.save();
      if (b.unitLabel) {
        const rt = await RoomType.findById(b.roomTypeId);
        const unit =
          rt && (rt.units || []).find((u) => u.label === b.unitLabel);
        if (unit) {
          unit.housekeeping = "dirty";
          unit.updatedAt = new Date();
          await rt.save();
        }
      }
      const folioTotal = (b.folio || []).reduce(
        (a, f) => a + (f.amount || 0) * (f.quantity || 1),
        0,
      );
      return {
        code: b.code,
        guest: b.guestName,
        checkedOut: true,
        roomCharge: b.totalAmount,
        extras: folioTotal,
        total: b.totalAmount + folioTotal,
        currency: b.currency,
      };
    },
  },
  {
    name: "cancel_booking",
    description: "Cancel a booking by code. Use for 'cancel BK-1234'.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
        reason: { type: "string" },
      },
      required: ["code"],
    },
    async run(args, ctx) {
      const HotelBooking = require("../../models/HotelBooking");
      const { cancelBooking } = require("../hotel/bookingService");
      const b = await HotelBooking.findOne({
        workspaceId: ctx.workspace._id,
        code: new RegExp("^" + String(args.code).trim() + "$", "i"),
      });
      if (!b) return { error: "No booking with code " + args.code + "." };
      const res = await cancelBooking(b._id, {
        reason: args.reason || "cancelled by owner via agent",
        workspaceId: ctx.workspace._id,
      });
      return res.ok
        ? { cancelled: true, code: b.code, guest: b.guestName }
        : { error: "Could not cancel (" + res.reason + ")." };
    },
  },
  {
    name: "block_room",
    description:
      "Block a room type for dates so it cannot be sold (maintenance, owner use). Creates an internal booking.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        room: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD exclusive" },
        reason: { type: "string" },
      },
      required: ["from", "to"],
    },
    async run(args, ctx) {
      const { createBooking } = require("../hotel/bookingService");
      const rt = await findRoom(ctx, args.room);
      if (!rt) return { error: "I could not find that room type." };
      const res = await createBooking({
        workspace: ctx.workspace,
        roomTypeId: rt._id,
        checkIn: args.from,
        checkOut: args.to,
        guestName: "BLOCKED — " + (args.reason || "unavailable"),
        source: "manual",
        nightlyRate: 0,
      });
      return res.ok
        ? {
            blocked: true,
            room: rt.name,
            from: fmt(res.booking.checkIn),
            to: fmt(res.booking.checkOut),
            code: res.booking.code,
          }
        : { error: "Could not block those dates (" + res.reason + ")." };
    },
  },
  {
    name: "reply_to_review",
    description:
      "Approve and send a reply to a guest review. Pass the review id and the reply text.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
      },
      required: ["id", "text"],
    },
    async run(args, ctx) {
      const Review = require("../../models/Review");
      const r = await Review.findOne({
        _id: args.id,
        workspaceId: ctx.workspace._id,
      });
      if (!r) return { error: "Review not found." };
      r.reply.draft = args.text;
      r.reply.status = "approved";
      r.reply.approvedAt = new Date();
      await r.save();
      return { replied: true, guest: r.guestName };
    },
  },
  {
    name: "message_guest",
    description:
      "Send a WhatsApp/Instagram message to a guest by booking code. Use for 'tell BK-1234 their room is ready'.",
    confirm: true,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
        text: { type: "string" },
      },
      required: ["code", "text"],
    },
    async run(args, ctx) {
      const HotelBooking = require("../../models/HotelBooking");
      const Conversation = require("../../models/Conversation");
      const Contact = require("../../models/Contact");
      const b = await HotelBooking.findOne({
        workspaceId: ctx.workspace._id,
        code: new RegExp("^" + String(args.code).trim() + "$", "i"),
      });
      if (!b) return { error: "No booking with code " + args.code + "." };
      if (!b.conversationId && !b.contactId) {
        return {
          error:
            "That booking came from an OTA and has no chat with us, so I cannot message them here.",
        };
      }
      const conversation = b.conversationId
        ? await Conversation.findById(b.conversationId)
        : await Conversation.findOne({ contactId: b.contactId });
      const contact = await Contact.findById(b.contactId).select("igUserId");
      if (!conversation || !contact || !contact.igUserId) {
        return { error: "I could not find an open chat with that guest." };
      }
      const {
        resolveSendTransport,
      } = require("../instagram/automationEngine");
      const transport = await resolveSendTransport(ctx.workspace, conversation);
      const res = await transport.send(contact.igUserId, args.text, {
        conversationId:
          (conversation.metadata && conversation.metadata.providerConversationId) ||
          undefined,
      });
      return res.success
        ? { sent: true, guest: b.guestName, channel: transport.channel }
        : { error: res.error || "Message failed to send." };
    },
  },
];

const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** OpenAI/Gemini-compatible function declarations. */
const toolSchemas = () =>
  TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

/** Execute a tool by name. Never throws. */
async function runTool(name, args, ctx) {
  const tool = byName[name];
  if (!tool) return { error: "Unknown tool: " + name };
  try {
    return await tool.run(args || {}, ctx);
  } catch (err) {
    logger.warn("[agent] tool " + name + " failed", { err: err.message });
    return { error: err.message };
  }
}

const needsConfirm = (name) => !!(byName[name] && byName[name].confirm);

module.exports = { TOOLS, byName, toolSchemas, runTool, needsConfirm };
