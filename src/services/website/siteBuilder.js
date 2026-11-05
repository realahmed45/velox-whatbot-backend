/**
 * Website content — generate it from the hotel's own data, and assemble the
 * public payload every template renders.
 *
 * No LLM: the copy is templated per property type, written to read like a
 * small hotel's own site rather than a generator's. Everything here is a
 * starting point the hotelier edits in "Manage your website".
 */
const { galleryFor, roomPhotoFor } = require("./stockPhotos");

const TYPE = {
  hotel: { noun: "hotel", label: "Hotel", vibe: "a calm, well-run hotel" },
  resort: { noun: "resort", label: "Resort", vibe: "a resort made for slow days" },
  villa: { noun: "villa", label: "Villa", vibe: "a private villa that feels like your own" },
  guesthouse: { noun: "guesthouse", label: "Guesthouse", vibe: "a friendly, family-run guesthouse" },
  hostel: { noun: "hostel", label: "Hostel", vibe: "a social, easy-going hostel" },
  apartment: { noun: "apartment", label: "Apartments", vibe: "a home base with space to live" },
};

const DEFAULT_AMENITIES = {
  hotel: ["Free Wi-Fi", "Air conditioning", "Daily housekeeping", "24-hour front desk", "Breakfast available", "Airport transfers", "Luggage storage", "Hot showers"],
  resort: ["Swimming pool", "Free Wi-Fi", "Restaurant & bar", "Spa treatments", "Airport transfers", "Daily housekeeping", "Garden", "Room service"],
  villa: ["Private pool", "Fully equipped kitchen", "Free Wi-Fi", "Air conditioning", "Daily housekeeping", "Garden", "Free parking", "Airport transfers"],
  guesthouse: ["Free Wi-Fi", "Breakfast available", "Air conditioning", "Garden", "Local tips from the family", "Airport transfers", "Laundry service", "Hot showers"],
  hostel: ["Free Wi-Fi", "Shared kitchen", "Lockers", "Common lounge", "Laundry", "Tours desk", "Air conditioning", "Hot showers"],
  apartment: ["Full kitchen", "Free Wi-Fi", "Washing machine", "Air conditioning", "Workspace", "Self check-in", "Free parking", "Smart TV"],
};

const COUNTRY_NAMES = {
  ID: "Indonesia", TH: "Thailand", MY: "Malaysia", SG: "Singapore", PH: "Philippines",
  VN: "Vietnam", AU: "Australia", US: "United States", GB: "United Kingdom",
  AE: "United Arab Emirates", IN: "India", PK: "Pakistan", LK: "Sri Lanka",
  MV: "Maldives", ES: "Spain", IT: "Italy", FR: "France", PT: "Portugal", GR: "Greece",
  MX: "Mexico", TR: "Turkey", JP: "Japan", MA: "Morocco", EG: "Egypt",
};

// Country → calling code, for turning a local "0812…" into an international number.
const CALLING_CODES = {
  indonesia: "62", id: "62", thailand: "66", th: "66", malaysia: "60", my: "60",
  singapore: "65", sg: "65", philippines: "63", ph: "63", vietnam: "84", vn: "84",
  australia: "61", au: "61", "united kingdom": "44", gb: "44", uk: "44", india: "91",
  in: "91", pakistan: "92", pk: "92", "sri lanka": "94", lk: "94", maldives: "960",
  mv: "960", "united arab emirates": "971", ae: "971", turkey: "90", tr: "90",
  spain: "34", es: "34", italy: "39", it: "39", france: "33", fr: "33",
  portugal: "351", pt: "351", greece: "30", gr: "30", morocco: "212", ma: "212",
  egypt: "20", eg: "20", japan: "81", jp: "81", mexico: "52", mx: "52",
};

const clean = (s, max = 2000) => String(s == null ? "" : s).trim().slice(0, max);

function countryName(c) {
  const v = clean(c, 80);
  return COUNTRY_NAMES[v.toUpperCase()] || v;
}

/**
 * "+62 812-3456 7890" → "6281234567890"; "0812 3456 7890" (+ Indonesia) →
 * "6281234567890". Returns "" when it can't be a real number.
 */
function normalizeWhatsapp(raw, country) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (!d) return "";
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) {
    const cc = CALLING_CODES[String(country || "").trim().toLowerCase()];
    if (cc) d = cc + d.slice(1);
  }
  d = d.replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : "";
}

function placeLine(p) {
  return [clean(p.city, 80), countryName(p.country)].filter(Boolean).join(", ");
}

/** Build the first version of a site's content from the property + rooms. */
function generateContent(property, roomTypes = [], { whatsappNumber = "" } = {}) {
  const type = TYPE[property.propertyType] ? property.propertyType : "hotel";
  const t = TYPE[type];
  const name = clean(property.name, 120) || "Our place";
  const city = clean(property.city, 80);
  const place = placeLine(property);
  const where = city ? ` in ${city}` : "";

  // Photos: the hotel's own first, room photos next, stock to fill the gaps.
  const own = [
    ...(property.photos || []).map((p) => ({ url: p.url, caption: p.caption || "", stock: false })),
    ...roomTypes.flatMap((r) =>
      (r.photos || []).map((p) => ({ url: p.url, caption: p.caption || r.name, stock: false })),
    ),
  ].filter((p) => p.url && /^https?:\/\//.test(p.url));
  const stock = galleryFor(type);
  const gallery = own.length ? own.slice(0, 24) : stock;
  const heroImage = (own[0] || stock[0]).url;
  const aboutImage = (own[1] || stock[1] || stock[0]).url;

  const rooms = roomTypes.filter((r) => r.active !== false);
  const roomWord =
    rooms.length > 1
      ? `${rooms.length} kinds of room, from ${rooms[0].name} to ${rooms[rooms.length - 1].name}`
      : rooms.length === 1
        ? `our ${rooms[0].name}`
        : "rooms for every kind of trip";

  const ownDescription = clean(property.description, 4000);
  const aboutBody =
    ownDescription.length > 60
      ? ownDescription
      : [
          `${name} is ${t.vibe}${where}. We keep things simple: comfortable rooms, honest prices and people who actually answer when you message.`,
          `Choose from ${roomWord}. Check-in is from ${property.checkInTime || "14:00"} and check-out by ${property.checkOutTime || "11:00"}, and if you need something different, just ask — we'll always try.`,
          `Book directly with us for the best rate. Message us on WhatsApp any time; we reply fast, in your language.`,
        ].join("\n\n");

  const subtitleByType = {
    hotel: `Thoughtful rooms and warm service${where}.`,
    resort: `Your escape${where} — pools, sunsets and nowhere you need to be.`,
    villa: `A private villa${where}, made for long breakfasts and lazy afternoons.`,
    guesthouse: `A warm welcome${where}, the way travel used to feel.`,
    hostel: `Good beds, great people and the best of ${city || "the city"} on your doorstep.`,
    apartment: `Space to live like a local${where} — for a weekend or a month.`,
  };

  const highlights = [
    {
      title: "Book direct, pay less",
      body: "No booking-site fees. Message us and we'll confirm your room in minutes.",
    },
    {
      title: "Answers in minutes",
      body: "Questions about rooms, transfers or the area? We reply on WhatsApp day and night.",
    },
    {
      title: place ? `The best of ${city || place}` : "A great location",
      body: "Restaurants, beaches and sights close by — ask us for our favourite spots.",
    },
  ];

  const address = clean(property.address, 300);
  const amenities =
    Array.isArray(property.amenities) && property.amenities.length
      ? property.amenities.slice(0, 24)
      : DEFAULT_AMENITIES[type];

  const wa = normalizeWhatsapp(whatsappNumber || property.phone, property.country);

  return {
    hero: {
      title: name,
      subtitle: subtitleByType[type],
      image: heroImage,
    },
    about: {
      heading: `Welcome to ${name}`,
      body: aboutBody,
      image: aboutImage,
    },
    highlights,
    amenities,
    gallery,
    location: {
      address: [address, place].filter(Boolean).join(", "),
      mapQuery: [name, address, city, countryName(property.country)].filter(Boolean).join(", "),
      directions: `We'll send you directions and can arrange an airport pickup — just message us on WhatsApp with your flight details.`,
    },
    contact: {
      phone: clean(property.phone, 40) || (wa ? `+${wa}` : ""),
      email: clean(property.email, 120),
      whatsapp: wa,
    },
    testimonials: [], // never invented — the hotelier adds real ones
    seo: {
      title: `${name}${city ? ` — ${t.label} in ${city}` : ""}`.slice(0, 70),
      description: `${name} is ${t.vibe}${where}. Book direct for the best rate and message us on WhatsApp for anything you need.`.slice(0, 160),
    },
  };
}

/**
 * The public shape every template renders. Used for the live site, the
 * template preview inside the app, and the manage-page preview pane.
 */
function buildSite(website, property, roomTypes = []) {
  const w = website.toObject ? website.toObject() : website;
  const type = TYPE[property.propertyType] ? property.propertyType : "hotel";
  const overrides = new Map(
    (w.roomOverrides || []).map((o) => [String(o.roomTypeId), o]),
  );
  const rooms = roomTypes
    .filter((r) => r.active !== false)
    .filter((r) => !overrides.get(String(r._id))?.hidden)
    .map((r, i) => {
      const o = overrides.get(String(r._id)) || {};
      const photos = (r.photos || []).map((p) => p.url).filter(Boolean);
      const occ = r.maxOccupancy || r.maxAdults || 2;
      return {
        id: String(r._id),
        name: r.name,
        description:
          clean(o.description, 1500) ||
          clean(r.description, 1500) ||
          `A comfortable ${r.name.toLowerCase()} for up to ${occ} guest${occ === 1 ? "" : "s"}${r.bedConfig ? `, with ${r.bedConfig}` : ""}. Air-conditioned, spotless, and ready when you arrive.`,
        image: o.image || photos[0] || roomPhotoFor(type, i),
        images: photos,
        price: r.baseRate || 0,
        currency: r.currency || property.currency || "USD",
        maxOccupancy: occ,
        bedConfig: r.bedConfig || "",
        sizeSqm: r.sizeSqm || null,
        amenities: (r.amenities || []).slice(0, 8),
        breakfastIncluded: !!r.breakfast?.included,
      };
    });

  const bookingSlug =
    property.directBooking?.enabled !== false ? property.directBooking?.slug : null;
  const c = w.content || {};

  return {
    slug: w.slug,
    templateId: w.templateId,
    published: w.published !== false,
    accent: w.accent || "",
    whatsapp: w.whatsappNumber || c.contact?.whatsapp || "",
    bookingUrl: bookingSlug ? `/book/${bookingSlug}` : null,
    hotel: {
      name: property.name,
      type,
      typeLabel: TYPE[type].label,
      city: property.city || "",
      country: countryName(property.country),
      address: property.address || "",
      checkIn: property.checkInTime || "14:00",
      checkOut: property.checkOutTime || "11:00",
      currency: property.currency || "USD",
      starRating: property.starRating || 0,
    },
    content: {
      hero: c.hero || {},
      about: c.about || {},
      highlights: c.highlights || [],
      amenities: c.amenities || [],
      gallery: (c.gallery || []).filter((g) => g && g.url),
      location: c.location || {},
      contact: c.contact || {},
      testimonials: (c.testimonials || []).filter((t) => t && t.quote),
      seo: c.seo || {},
    },
    rooms,
  };
}

module.exports = {
  generateContent,
  buildSite,
  normalizeWhatsapp,
  countryName,
  DEFAULT_AMENITIES,
};
