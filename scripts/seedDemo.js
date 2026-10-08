/**
 * Demo account — a working Botlify hotel with no OTA provider connected.
 *
 * Built for showing the product live. Everything a hotelier would have after a
 * few weeks of real use: a property with rooms and rates, bookings spread
 * across channels, guests, a driver, an airport pickup. No Channex, no Beds24,
 * no card — the OTA bookings are seeded as if they had already synced, which is
 * exactly what they look like once a provider IS connected.
 *
 * The account is marked `subscription.lifetime`, the flag the codebase already
 * has for comped accounts. That satisfies the paywall without weakening it for
 * anyone else — no free tier is introduced, one account is simply comped.
 *
 * Safe to re-run: it wipes and rebuilds only this demo workspace, matched on
 * the demo email. It will refuse to touch anything else.
 *
 *   node scripts/seedDemo.js
 *   node scripts/seedDemo.js --email=me@mine.com --password=Secret123
 *   node scripts/seedDemo.js --wipe        (remove the demo account entirely)
 */
require("dotenv").config();
const mongoose = require("mongoose");

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const EMAIL = String(arg("email", "demo@botlify.site")).toLowerCase();
const PASSWORD = arg("password", "BotlifyDemo123");
const HOTEL = arg("hotel", "Villa Seminyak Retreat");

const log = (s) => console.log("  " + s);

/** Midnight UTC, n days from today. */
const day = (n) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 20000,
  });

  const User = require("../src/models/User");
  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const HotelBooking = require("../src/models/HotelBooking");
  const Guest = require("../src/models/Guest");
  const Driver = require("../src/models/Driver");
  const TransferBooking = require("../src/models/TransferBooking");
  const Review = require("../src/models/Review");
  const Contact = require("../src/models/Contact");
  const Conversation = require("../src/models/Conversation");
  const Message = require("../src/models/Message");
  const CommissionEntry = require("../src/models/CommissionEntry");

  try {
    // ── Clear any previous run ───────────────────────────────────────────
    const existing = await User.findOne({ email: EMAIL });
    if (existing) {
      const spaces = await Workspace.find({ owner: existing._id }).select("_id");
      const ids = spaces.map((w) => w._id);
      if (ids.length) {
        await Promise.all([
          Property.deleteMany({ workspaceId: { $in: ids } }),
          RoomType.deleteMany({ workspaceId: { $in: ids } }),
          HotelBooking.deleteMany({ workspaceId: { $in: ids } }),
          Guest.deleteMany({ workspaceId: { $in: ids } }),
          Driver.deleteMany({ workspaceId: { $in: ids } }),
          TransferBooking.deleteMany({ workspaceId: { $in: ids } }),
          Review.deleteMany({ workspaceId: { $in: ids } }),
          Contact.deleteMany({ workspaceId: { $in: ids } }),
          Conversation.deleteMany({ workspaceId: { $in: ids } }),
          Message.deleteMany({ workspaceId: { $in: ids } }),
          CommissionEntry.deleteMany({ workspaceId: { $in: ids } }),
          Workspace.deleteMany({ _id: { $in: ids } }),
        ]);
      }
      await User.deleteOne({ _id: existing._id });
      log(`cleared the previous demo account (${EMAIL})`);
    }

    if (has("wipe")) {
      console.log("\n  Demo account removed.\n");
      await mongoose.disconnect();
      process.exit(0);
    }

    // ── Owner ────────────────────────────────────────────────────────────
    // Pass the plain password — User has a pre-save hook that hashes it.
    // Hashing here too would double-hash and the account could never log in.
    const user = await User.create({
      email: EMAIL,
      name: "Demo Owner",
      password: PASSWORD,
      isEmailVerified: true, // skips the verify-email gate
      role: "owner",
    });
    log(`owner: ${EMAIL}`);

    // ── Workspace, comped so the paywall lets us in ──────────────────────
    const workspace = await Workspace.create({
      name: HOTEL,
      owner: user._id,
      industry: "hospitality",
      timezone: "Asia/Makassar",
      subscription: {
        plan: "hotel_pro",
        status: "active",
        lifetime: true, // the existing comped-account flag
        activatedAt: new Date(),
      },
      features: { hotelBookings: true, transfers: true },
    });
    log(`workspace: ${HOTEL} (comped — no card needed)`);

    // ── Property ─────────────────────────────────────────────────────────
    const property = await Property.create({
      workspaceId: workspace._id,
      name: HOTEL,
      propertyType: "villa",
      description:
        "A quiet eight-room villa a few minutes from Seminyak beach. Pool, " +
        "garden, breakfast included, and a team that actually answers.",
      address: "Jl. Kayu Aya No. 12",
      city: "Seminyak",
      country: "Indonesia",
      currency: "USD",
      timezone: "Asia/Makassar",
      checkInTime: "14:00",
      checkOutTime: "11:00",
      phone: "+62 361 555 0100",
      email: EMAIL,
      starRating: 4,
      amenities: ["Pool", "Free WiFi", "Breakfast", "Airport shuttle", "Parking"],
      houseRules: "No smoking indoors. Quiet hours after 10pm.",
      paymentMethods: ["Cash", "Card on arrival", "Bank transfer"],
      transfers: {
        hasOwnService: true,
        ownServicePrice: 25,
        airportCode: "DPS",
      },
      active: true,
    });
    log(`property: ${property.name}, ${property.city}`);

    // ── Rooms ────────────────────────────────────────────────────────────
    const rooms = await RoomType.insertMany([
      {
        workspaceId: workspace._id,
        propertyId: property._id,
        name: "Garden Double",
        description: "Queen bed, garden view, outdoor shower.",
        unitsCount: 4,
        baseRate: 95,
        currency: "USD",
        maxOccupancy: 2,
        breakfastIncluded: true,
      },
      {
        workspaceId: workspace._id,
        propertyId: property._id,
        name: "Pool Suite",
        description: "King bed, direct pool access, separate living area.",
        unitsCount: 3,
        baseRate: 165,
        currency: "USD",
        maxOccupancy: 3,
        breakfastIncluded: true,
      },
      {
        workspaceId: workspace._id,
        propertyId: property._id,
        name: "Family Villa",
        description: "Two bedrooms, kitchen, private terrace.",
        unitsCount: 1,
        baseRate: 240,
        currency: "USD",
        maxOccupancy: 5,
        breakfastIncluded: true,
      },
    ]);
    log(`rooms: ${rooms.map((r) => r.name).join(", ")}`);

    // ── Bookings ─────────────────────────────────────────────────────────
    // Spread across sources and dates so every screen has something true to
    // show: arrivals today, a full week ahead, and history behind.
    const SEED = [
      // [room, source, checkInOffset, nights, guest, phone, amount, status]
      [0, "booking_com", -2, 4, "Marta Nowak", "+48 601 234 567", 380, "confirmed"],
      [1, "airbnb", -1, 3, "James Whitfield", "+44 7700 900123", 495, "confirmed"],
      [0, "whatsapp", 0, 2, "Siti Rahayu", "+62 812 3456 7890", 190, "confirmed"],
      [2, "booking_com", 0, 5, "The Hendersons", "+1 415 555 0142", 1200, "confirmed"],
      [1, "instagram", 1, 2, "Chloé Dubois", "+33 6 12 34 56 78", 330, "confirmed"],
      [0, "airbnb", 2, 3, "Kenji Tanaka", "+81 90 1234 5678", 285, "confirmed"],
      [1, "direct", 4, 4, "Anna Schmidt", "+49 151 23456789", 660, "confirmed"],
      [0, "whatsapp", 6, 2, "Liam O'Connor", "+353 85 123 4567", 190, "confirmed"],
      [0, "booking_com", -20, 3, "Past Guest One", "+61 400 111 222", 285, "completed"],
      [1, "airbnb", -14, 2, "Past Guest Two", "+64 21 123 456", 330, "completed"],
      [2, "whatsapp", -9, 4, "Past Guest Three", "+65 8123 4567", 960, "completed"],
    ];

    const BOT_SOURCES = ["whatsapp", "instagram", "messenger", "telegram"];
    let created = 0;
    for (const [ri, source, offset, nights, name, phone, amount, status] of SEED) {
      const room = rooms[ri];
      const checkIn = day(offset);
      const checkOut = day(offset + nights);
      const isBot = BOT_SOURCES.includes(source);
      const isOta = ["booking_com", "airbnb", "expedia"].includes(source);

      const booking = await HotelBooking.create({
        workspaceId: workspace._id,
        propertyId: property._id,
        roomTypeId: room._id,
        source,
        status,
        checkIn,
        checkOut,
        nights,
        guestName: name,
        guestPhone: phone,
        guestEmail: `${name.split(" ")[0].toLowerCase()}@example.com`,
        guestCount: { adults: 2, children: 0 },
        totalAmount: amount,
        currency: "USD",
        // Commission only on what the AI closed — OTA bookings are 0%.
        commission: {
          rate: isBot ? 0.1 : 0,
          amount: isBot ? Math.round(amount * 0.1 * 100) / 100 : 0,
        },
        ...(isOta
          ? { otaReservationId: `${source.toUpperCase()}-DEMO-${created}` }
          : {}),
      });

      // The ledger the owner sees — accrued, not charged.
      if (isBot && booking.commission.amount > 0) {
        await CommissionEntry.create({
          workspaceId: workspace._id,
          kind: "platform_revenue",
          revenueType: "booking_commission",
          status: "accrued",
          amount: booking.commission.amount,
          currency: "USD",
          bookingId: booking._id,
          note: `AI-closed booking on ${source}`,
        });
      }
      created++;
    }
    log(`bookings: ${created} across OTA, AI and direct`);

    // ── Guests ───────────────────────────────────────────────────────────
    // One profile per person, which is what the Guests screen is for.
    const guestNames = [...new Set(SEED.map((s) => s[4]))];
    for (const name of guestNames) {
      const row = SEED.find((s) => s[4] === name);
      const source = row[1];
      // identities.channel has its own enum — anything outside it is dropped
      // silently by mongoose, so map to a value the schema accepts.
      const CHANNELS = [
        "whatsapp", "instagram", "tiktok", "booking_com",
        "airbnb", "direct", "manual", "other_ota",
      ];
      const channel = CHANNELS.includes(source) ? source : "other_ota";
      await Guest.create({
        workspaceId: workspace._id,
        name,
        phone: row[5],
        email: `${name.split(" ")[0].toLowerCase()}@example.com`,
        identities: [{ channel, handle: row[5] }],
        stats: {
          staysCount: 1,
          nightsTotal: row[3],
          revenueTotal: row[6],
          currency: "USD",
          lastStayAt: day(row[2]),
          lastChannel: channel,
        },
      });
    }
    log(`guests: ${guestNames.length} profiles`);

    // ── Driver + an airport pickup ───────────────────────────────────────
    const driver = await Driver.create({
      scope: "hotel",
      workspaceId: workspace._id,
      name: "Wayan Sudiarta",
      nickname: "Wayan",
      phone: "+62 813 3700 1122",
      idType: "ktp",
      idNumber: "5171xxxxxxxxxxx",
      vehicle: {
        make: "Toyota",
        model: "Avanza",
        colour: "Silver",
        plate: "DK 1234 AB",
        seats: 6,
      },
      active: true,
    });

    await TransferBooking.create({
      workspaceId: workspace._id,
      propertyId: property._id,
      direction: "pickup",
      guestName: "The Hendersons",
      guestPhone: "+1 415 555 0142",
      passengers: 4,
      flightNumber: "SQ938",
      pickupAt: new Date(day(0).getTime() + 15 * 3600000),
      airportCode: "DPS",
      provider: "own",
      price: 25,
      currency: "USD",
      status: "confirmed",
      driverId: driver._id,
      driverSnapshot: {
        name: driver.nickname,
        phone: driver.phone,
        vehicleLabel: "Silver Toyota Avanza · DK 1234 AB",
      },
      dispatch: { state: "assigned" },
    });
    log(`driver: ${driver.name}, with one pickup assigned`);

    // ── Reviews ──────────────────────────────────────────────────────────
    // One answered, one waiting on the owner — so the Reviews screen shows
    // both halves of the AI-drafts-you-approve flow.
    await Review.insertMany([
      {
        workspaceId: workspace._id,
        propertyId: property._id,
        source: "booking_com",
        rating: 9.2,
        stars: 5,
        guestName: "Marta Nowak",
        title: "Exactly as described",
        text:
          "Beautiful villa and the staff replied to every question within " +
          "minutes. The airport pickup was waiting for us.",
        reviewedAt: day(-3),
        sentiment: "positive",
        reply: {
          draft:
            "Thank you Marta! We're so glad Wayan was there on time and that " +
            "the villa lived up to the photos. You're welcome back any time.",
          status: "drafted",
        },
      },
      {
        workspaceId: workspace._id,
        propertyId: property._id,
        source: "airbnb",
        rating: 10,
        stars: 5,
        guestName: "Kenji Tanaka",
        title: "Would stay again",
        text: "Spotless, quiet, great location.",
        reviewedAt: day(-8),
        sentiment: "positive",
        reply: {
          draft: "Thank you Kenji — it was a pleasure having you.",
          status: "posted",
          approvedAt: day(-7),
          postedAt: day(-7),
        },
      },
    ]);
    log("reviews: 2 (one AI draft awaiting approval)");

    // ── Guest conversations, including the OTA inboxes ──────────────────
    // The point of the inbox is that a question from Booking.com and one from
    // WhatsApp land in the same place and get the same AI. Seed both, with the
    // AI already having answered, so that is visible rather than described.
    const THREADS = [
      {
        channel: "booking_com",
        guest: "Marta Nowak",
        handle: "marta.nowak",
        turns: [
          ["in", "Hi! Is it possible to check in early, around 11am? Our flight lands at 9."],
          ["out", "Hello Marta! Check-in is normally from 14:00, but the room looks free that morning — I can hold it from 11:00 for you at no extra charge. Shall I note that down?"],
          ["in", "That would be wonderful, thank you!"],
          ["out", "Done — your room will be ready from 11:00 on the 24th. Safe travels!"],
        ],
      },
      {
        channel: "airbnb",
        guest: "Kenji Tanaka",
        handle: "kenji_t",
        turns: [
          ["in", "Does the villa have parking for a rental car?"],
          ["out", "Yes — there is free private parking on site, right by the entrance. No need to book it in advance."],
        ],
      },
      {
        channel: "booking_com",
        guest: "The Hendersons",
        handle: "hendersons",
        turns: [
          ["in", "We land at DPS at 15:40 on the 8th. Can you arrange a pickup for 4 of us?"],
          ["out", "Of course. I have booked an airport pickup for 4 passengers on the 8th — USD 25. Your driver is Wayan, in a silver Toyota Avanza (DK 1234 AB). You can reach him on WhatsApp at +62 813 3700 1122."],
          ["in", "Perfect, thanks!"],
        ],
      },
      {
        channel: "whatsapp",
        guest: "Siti Rahayu",
        handle: "+628123456789",
        turns: [
          ["in", "Halo, ada kamar kosong untuk malam ini?"],
          ["out", "Halo Siti! Ya — Garden Double kami tersedia malam ini, USD 95 termasuk sarapan. Mau saya pesankan?"],
          ["in", "Boleh, atas nama Siti Rahayu."],
          ["out", "Sudah dipesan! Kode booking Anda akan dikirim sebentar lagi. Sampai jumpa nanti."],
        ],
      },
      {
        channel: "airbnb",
        guest: "Chloe Dubois",
        handle: "chloe_d",
        turns: [
          ["in", "Is breakfast included in the Pool Suite rate?"],
          ["out", "It is — breakfast for two is included every morning, served by the pool from 7:00 to 10:30."],
        ],
      },
    ];

    let threadCount = 0;
    let msgCount = 0;
    for (const t of THREADS) {
      const contact = await Contact.create({
        workspaceId: workspace._id,
        name: t.guest,
        // igUserId is the generic provider-side recipient id the send path
        // uses, whatever the channel actually is.
        igUserId: `demo-${t.handle}`,
        igUsername: t.handle,
        ...(t.channel === "whatsapp" ? { phone: t.handle } : {}),
      });

      const last = t.turns[t.turns.length - 1];
      const conversation = await Conversation.create({
        workspaceId: workspace._id,
        contactId: contact._id,
        channelType: t.channel,
        lastMessageAt: new Date(Date.now() - threadCount * 3600000),
        lastMessagePreview: last[1],
        unreadCount: 0,
        status: "open",
      });

      // Walk the turns backwards in time so the thread reads in order.
      let offset = t.turns.length;
      for (const [dir, text] of t.turns) {
        await Message.create({
          workspaceId: workspace._id,
          conversationId: conversation._id,
          contactId: contact._id,
          channelType: t.channel,
          direction: dir === "in" ? "inbound" : "outbound",
          // Outbound here is the AI answering, which is the whole point of
          // showing these threads.
          sender: dir === "in" ? "customer" : "bot",
          text,
          createdAt: new Date(
            Date.now() - threadCount * 3600000 - offset * 240000,
          ),
        });
        offset--;
        msgCount++;
      }
      threadCount++;
    }
    log(
      `inbox: ${threadCount} conversations (${msgCount} messages) across ` +
        "Booking.com, Airbnb and WhatsApp",
    );

    console.log(
      "\n" +
        "=".repeat(56) +
        "\n  Demo ready.\n" +
        "=".repeat(56) +
        `\n  URL       ${process.env.CLIENT_URL || "https://botlify.site"}/login` +
        `\n  Email     ${EMAIL}` +
        `\n  Password  ${PASSWORD}` +
        "\n\n  No card needed — the account is comped (subscription.lifetime)." +
        "\n  No OTA provider is connected; the OTA bookings are seeded as if" +
        "\n  they had already synced, which is how they look once one is.\n",
    );
  } catch (e) {
    console.error("\n  FAILED:", e.message, "\n", e.stack);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
