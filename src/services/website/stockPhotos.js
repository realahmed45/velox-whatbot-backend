/**
 * Placeholder photography for a hotel website that has no photos of its own
 * yet. Every id below was checked to resolve on images.unsplash.com and to
 * show what its caption says. The frontend keeps a mirror of this list for the
 * template demo (src/website/stock.js) — keep them in step.
 */
const u = (id, w = 1600) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;

const P = {
  // Exteriors, pools, views
  resortPool: "1566073771259-6a8506099945",
  hotelFacade: "1542314831-068cd1dbfeeb",
  hotelBuilding: "1551882547-ff40c63fe5fa",
  poolPalms: "1520250497591-112f2f40a3f4",
  poolLoungers: "1571896349842-33c89424de2d",
  poolSunset: "1571003123894-1f0594d2b5d9",
  infinityPool: "1586611292717-f828b167408c",
  resortTropical: "1540541338287-41700207dee6",
  overwater: "1573843981267-be1999ff37cd",
  baliVillaPool: "1602002418082-a4443e081dd1",
  modernVilla: "1613490493576-7fde63acd811",
  luxuryHouse: "1600596542815-ffad4c1539a9",
  modernHouse: "1600585154340-be6161a56a0c",
  villaExterior: "1512917774080-9991f1c4c750",
  housePool: "1564013799919-ab600027ffc6",
  houseFront: "1568605114967-8130f3a36994",
  houseClassic: "1570129477492-45c003edd2be",
  cabin: "1449844908441-8829872d2607",
  beach: "1507525428034-b723cf961d3e",
  // Rooms & interiors
  roomBed: "1582719478250-c89cae4dc85b",
  roomSuite: "1611892440504-42a792e24d32",
  roomDouble: "1590490360182-c33d57733427",
  roomWhite: "1618773928121-c32242e63f39",
  roomModern: "1631049307264-da0ec9d70304",
  roomClassic: "1578683010236-d716f9a3f461",
  roomWarm: "1584132967334-10e028bd69f7",
  roomLights: "1587985064135-0366536eab42",
  roomCozy: "1455587734955-081b22074882",
  roomView: "1561501900-3701fa6a0864",
  roomKing: "1566665797739-1674de7a421a",
  roomTwin: "1591088398332-8a7791972843",
  lobby: "1564501049412-61c2a3083791",
  interior: "1445019980597-93fa8acb246c",
  bunk: "1555854877-bab0e564b8d5",
  bunkWood: "1520277739336-7bf67edfa768",
  aptLiving: "1502672260266-1c1ef2d93688",
  aptInterior: "1522708323590-d24dbb6b0267",
  aptBright: "1560448204-e02f11c3d0e2",
  livingRoom: "1493809842364-78817add7ffb",
  bedroom: "1505693416388-ac5ce068fe85",
  kitchen: "1484154218962-a197022b5858",
  interiorWarm: "1600607687939-ce8a6c25118c",
  bathroom: "1584622650111-993a426fbf0a",
  bathroomStone: "1552321554-5fefe8c9ef14",
  // Experiences
  spa: "1544161515-4ab6ce6db874",
  restaurant: "1414235077428-338989a2e8c0",
  dining: "1517248135467-4c7edcad34c4",
  poolBlue: "1596394516093-501ba68a0ba6",
};

const C = {
  resortPool: "The pool", hotelFacade: "Arrival", hotelBuilding: "The hotel",
  poolPalms: "Poolside", poolLoungers: "Sun loungers", poolSunset: "Evenings by the pool",
  infinityPool: "Infinity pool", resortTropical: "Tropical gardens", overwater: "Over the water",
  baliVillaPool: "Private pool", modernVilla: "The villa", luxuryHouse: "Outside at dusk",
  modernHouse: "The house", villaExterior: "The villa", housePool: "Pool terrace",
  houseFront: "Welcome", houseClassic: "Our home", cabin: "Our place", beach: "The beach",
  roomBed: "Guest room", roomSuite: "Suite", roomDouble: "Double room", roomWhite: "Bedroom",
  roomModern: "Room details", roomClassic: "Classic room", roomWarm: "Cosy room",
  roomLights: "Evening light", roomCozy: "Room", roomView: "Room with a view",
  roomKing: "King room", roomTwin: "Twin room", lobby: "The lobby", interior: "Lounge",
  bunk: "Dorm", bunkWood: "Bunk room", aptLiving: "Living room", aptInterior: "Open plan living",
  aptBright: "Bright interiors", livingRoom: "Lounge", bedroom: "Bedroom", kitchen: "Kitchen",
  interiorWarm: "Interiors", bathroom: "Bathroom", bathroomStone: "Bathroom",
  spa: "Spa", restaurant: "Restaurant", dining: "Dining", poolBlue: "Pool",
};

const BY_TYPE = {
  hotel: {
    gallery: ["hotelFacade", "resortPool", "lobby", "roomSuite", "restaurant", "roomBed", "spa", "bathroomStone"],
    rooms: ["roomBed", "roomSuite", "roomDouble", "roomKing", "roomTwin", "roomClassic"],
  },
  resort: {
    gallery: ["resortTropical", "infinityPool", "poolSunset", "overwater", "roomView", "spa", "dining", "beach"],
    rooms: ["roomView", "roomSuite", "roomWhite", "roomKing", "roomBed", "roomModern"],
  },
  villa: {
    gallery: ["baliVillaPool", "modernVilla", "housePool", "interiorWarm", "bedroom", "livingRoom", "bathroomStone", "luxuryHouse"],
    rooms: ["bedroom", "roomWhite", "roomWarm", "roomCozy", "roomModern", "roomLights"],
  },
  guesthouse: {
    gallery: ["houseClassic", "roomCozy", "interiorWarm", "roomWarm", "kitchen", "poolBlue", "bathroom", "houseFront"],
    rooms: ["roomCozy", "roomWarm", "roomClassic", "roomDouble", "roomTwin", "roomBed"],
  },
  hostel: {
    gallery: ["bunk", "bunkWood", "livingRoom", "kitchen", "aptBright", "roomTwin", "poolBlue", "hotelBuilding"],
    rooms: ["bunk", "bunkWood", "roomTwin", "roomCozy", "roomDouble", "roomBed"],
  },
  apartment: {
    gallery: ["aptLiving", "aptInterior", "aptBright", "kitchen", "bedroom", "livingRoom", "bathroom", "modernHouse"],
    rooms: ["bedroom", "aptInterior", "roomWhite", "roomModern", "roomCozy", "aptBright"],
  },
};

function forType(type) {
  return BY_TYPE[type] || BY_TYPE.hotel;
}

/** [{ url, caption, stock: true }] — the gallery set for a property type. */
function galleryFor(type) {
  return forType(type).gallery.map((k) => ({ url: u(P[k]), caption: C[k] || "", stock: true }));
}

/** A room photo for the i-th room of a property of this type. */
function roomPhotoFor(type, i) {
  const list = forType(type).rooms;
  return u(P[list[i % list.length]], 1200);
}

function isStockUrl(url) {
  return typeof url === "string" && url.startsWith("https://images.unsplash.com/");
}

module.exports = { galleryFor, roomPhotoFor, isStockUrl, BY_TYPE, PHOTOS: P };
