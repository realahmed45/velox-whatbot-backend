/**
 * testZodomus — offline checks for the Zodomus connector.
 *
 * No network, no database: pins the payload shapes we send and the way we read
 * reservations back, so when the field-level docs arrive (sandbox login) any
 * correction shows up here as a deliberate, visible change.
 */
process.env.ZODOMUS_API_USER = process.env.ZODOMUS_API_USER || "test_user";
process.env.ZODOMUS_API_PASSWORD = process.env.ZODOMUS_API_PASSWORD || "test_pass";

const z = require("../src/services/channels/zodomusService");
const router = require("../src/services/channels");

let pass = 0;
let fail = 0;
const check = (label, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ""}`);
  }
};

console.log("Zodomus connector");

check("configured from env", z.isConfigured() === true);
check("router knows zodomus", router.PROVIDER_NAMES.includes("zodomus"));
check(
  "router returns the service for a zodomus property",
  router.getProvider({ channel: { provider: "zodomus" } }) === z,
);
check(
  "providerRoomId reads the first channel mapping",
  router.providerRoomId(
    { channel: { provider: "zodomus" } },
    { zodomusRooms: [{ channelId: 1, roomId: "R7" }] },
  ) === "R7",
);

const chans = [
  { id: 1, name: "Booking.com" },
  { id: 2, name: "Expedia" },
  { id: 3, name: "Airbnb" },
];
check("channel name → booking_com", z.sourceFromChannel("Booking.com", chans) === "booking_com");
check("channel id → airbnb", z.sourceFromChannel(3, chans) === "airbnb");
check("unknown channel → other_ota", z.sourceFromChannel("Foo", chans) === "other_ota");

const av = z._build.buildAvailability({
  channelId: 1,
  otaPropertyId: 12345,
  roomId: 99,
  from: new Date("2026-12-01T00:00:00Z"),
  toInclusive: new Date("2026-12-03T00:00:00Z"),
  availability: -2,
});
check("availability dates are ISO days", av.dateFrom === "2026-12-01" && av.dateTo === "2026-12-03", av);
check("availability never negative", av.availability === 0, av.availability);
check("ids sent as strings", av.propertyId === "12345" && av.roomId === "99", av);

const rt = z._build.buildRates({
  channelId: 3,
  otaPropertyId: "L1",
  roomId: "R1",
  rateId: "P1",
  from: new Date("2026-12-01T00:00:00Z"),
  toInclusive: new Date("2026-12-01T00:00:00Z"),
  price: "120",
  currency: "IDR",
});
check("rate carries currency + numeric price", rt.currencyCode === "IDR" && rt.prices.price === 120, rt);

const act = z._build.buildRoomsActivation({
  channelId: 1,
  otaPropertyId: "P",
  rooms: [{ roomId: 5, roomName: "Deluxe", quantity: 4, rates: [{ rateId: 8, rateName: "BAR" }] }],
});
check("rooms activation keeps rates", act.rooms[0].rates[0].rateId === "8" && act.rooms[0].quantity === 4, act);

const one = z._normaliseReservation(
  {
    reservation: {
      id: "R-1",
      status: "new",
      currencyCode: "EUR",
      customer: { firstName: "Ana", lastName: "Silva", email: "a@x.io", telephone: "+351" },
      rooms: [
        { id: "5", arrivalDate: "2026-12-10", departureDate: "2026-12-12", numberOfAdults: 2, totalPrice: 300 },
      ],
    },
  },
  { channelId: 1, otaPropertyId: "P" },
);
check("single-room reservation → one booking", one.length === 1, one.length);
check("reservation id namespaced by channel", one[0].otaReservationId === "zodomus:1:R-1", one[0].otaReservationId);
check("guest name joined", one[0].guestName === "Ana Silva", one[0].guestName);
check("dates + money read", one[0].checkIn === "2026-12-10" && one[0].totalAmount === 300, one[0]);

const multi = z._normaliseReservation(
  { id: "R-2", status: "cancelled", rooms: [{ id: "5" }, { id: "6" }] },
  { channelId: 3, otaPropertyId: "L" },
);
check("multi-room reservation → one booking per room", multi.length === 2, multi.length);
check("multi-room ids stay unique", multi[0].otaReservationId !== multi[1].otaReservationId);
check("cancelled status mapped", multi[0].status === "cancelled", multi[0].status);

console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
