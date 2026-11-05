/**
 * websiteController — the hotel's own website (botlify.site/<slug>).
 *
 * Authenticated (owner manages it): get, generate from hotel data, update,
 * photo upload, slug check. Public (no auth): the assembled site by slug.
 */
const asyncHandler = require("express-async-handler");
const Website = require("../models/Website");
const { TEMPLATE_IDS, RESERVED_SLUGS } = require("../models/Website");
const Property = require("../models/Property");
const RoomType = require("../models/RoomType");
const { ensureSlug, slugify } = require("./publicBookingController");
const {
  generateContent,
  buildSite,
  normalizeWhatsapp,
} = require("../services/website/siteBuilder");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const MAX_GALLERY = 40;

const str = (v, max = 2000) => String(v == null ? "" : v).trim().slice(0, max);
const isUrl = (v) => typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());
const url = (v) => (isUrl(v) ? v.trim().slice(0, 1500) : "");

/** The property this request is about: ?propertyId / body.propertyId, else the first. */
async function resolveProperty(req, res) {
  const wanted = req.query?.propertyId || req.body?.propertyId;
  const q = { workspaceId: req.workspace._id };
  if (wanted) q._id = wanted;
  const property = await Property.findOne(q).sort({ createdAt: 1 });
  if (!property) {
    res.status(404);
    throw new Error("Set up your property first — your website is built from it.");
  }
  return property;
}

const roomsOf = (property) =>
  RoomType.find({ propertyId: property._id, active: true }).sort({ baseRate: 1, createdAt: 1 });

function validateSlug(slug) {
  if (!SLUG_RE.test(slug)) {
    return "Use 3–50 lowercase letters, numbers and dashes (no dash at the start or end).";
  }
  if (RESERVED_SLUGS.has(slug)) return "That address is reserved — try another.";
  return null;
}

/** A free slug derived from `base`, avoiding reserved words and existing sites. */
async function uniqueSlug(base, exceptId = null) {
  let root = slugify(base) || "stay";
  if (root.length < 3) root = `${root}-stay`;
  if (RESERVED_SLUGS.has(root)) root = `${root}-stay`;
  for (let i = 0; i < 8; i++) {
    const candidate =
      i === 0 ? root : `${root.slice(0, 44)}-${Math.random().toString(36).slice(2, 6)}`;
    const q = { slug: candidate };
    if (exceptId) q._id = { $ne: exceptId };
    if (!(await Website.exists(q))) return candidate;
  }
  return `${root.slice(0, 40)}-${Date.now().toString(36)}`;
}

function payload(website, property, rooms) {
  return {
    success: true,
    website,
    site: website ? buildSite(website, property, rooms) : null,
    property: {
      _id: property._id,
      name: property.name,
      propertyType: property.propertyType,
      city: property.city,
      country: property.country,
      phone: property.phone,
    },
  };
}

// @GET /api/website
const getWebsite = asyncHandler(async (req, res) => {
  const property = await resolveProperty(req, res);
  const [website, rooms] = await Promise.all([
    Website.findOne({ propertyId: property._id }),
    roomsOf(property),
  ]);
  res.json(payload(website, property, rooms));
});

// @GET /api/website/draft?templateId= — the site as it WOULD be generated,
// without saving. Lets the template gallery preview every design with the
// hotel's own data before they pick one.
const getDraft = asyncHandler(async (req, res) => {
  const property = await resolveProperty(req, res);
  const rooms = await roomsOf(property);
  const existing = await Website.findOne({ propertyId: property._id });
  const templateId = TEMPLATE_IDS.includes(req.query.templateId)
    ? req.query.templateId
    : existing?.templateId || "coastal";
  const draft = existing
    ? { ...existing.toObject(), templateId }
    : {
        slug: slugify(property.name) || "your-hotel",
        templateId,
        whatsappNumber: normalizeWhatsapp(property.phone, property.country),
        content: generateContent(property, rooms),
        roomOverrides: [],
      };
  res.json({ success: true, site: buildSite(draft, property, rooms) });
});

// @POST /api/website/generate { templateId, whatsappNumber?, keepPhotos? }
const generateWebsite = asyncHandler(async (req, res) => {
  const property = await resolveProperty(req, res);
  const b = req.body || {};
  const templateId = TEMPLATE_IDS.includes(b.templateId) ? b.templateId : null;
  const rooms = await roomsOf(property);

  // The booking page link the site's "Book now" buttons point at.
  await ensureSlug(property).catch(() => null);

  let website = await Website.findOne({ propertyId: property._id });
  const wa =
    b.whatsappNumber !== undefined
      ? normalizeWhatsapp(b.whatsappNumber, property.country)
      : website?.whatsappNumber || normalizeWhatsapp(property.phone, property.country);
  if (b.whatsappNumber && !wa) {
    res.status(400);
    throw new Error("That WhatsApp number doesn't look right — include your country code, e.g. +62 812 3456 7890.");
  }

  const content = generateContent(property, rooms, { whatsappNumber: wa });

  if (!website) {
    website = new Website({
      workspaceId: req.workspace._id,
      propertyId: property._id,
      slug: await uniqueSlug(property.name),
      templateId: templateId || "coastal",
      whatsappNumber: wa,
      content,
      published: true,
      generatedAt: new Date(),
    });
  } else {
    // Regenerate: fresh copy from the hotel data, but never throw away the
    // hotelier's own photos unless they asked to.
    const keepPhotos = b.keepPhotos !== false;
    const ownGallery = (website.content?.gallery || []).filter((g) => !g.stock);
    if (keepPhotos && ownGallery.length) {
      content.gallery = ownGallery;
      if (website.content?.hero?.image) content.hero.image = website.content.hero.image;
      if (website.content?.about?.image) content.about.image = website.content.about.image;
    }
    if (website.content?.testimonials?.length) {
      content.testimonials = website.content.testimonials;
    }
    website.content = content;
    if (templateId) website.templateId = templateId;
    website.whatsappNumber = wa;
    website.generatedAt = new Date();
  }

  try {
    await website.save();
  } catch (err) {
    if (err.code === 11000) {
      website.slug = await uniqueSlug(`${property.name}-${Date.now().toString(36)}`);
      await website.save();
    } else throw err;
  }

  // A hotel with no phone on file gets the WhatsApp number as its contact.
  if (wa && !property.phone) {
    await Property.updateOne({ _id: property._id }, { $set: { phone: `+${wa}` } });
    property.phone = `+${wa}`;
  }

  res.status(201).json(payload(website, property, rooms));
});

function sanitizePhotos(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((g) => (typeof g === "string" ? { url: g } : g || {}))
    .map((g) => ({ url: url(g.url), caption: str(g.caption, 200), stock: !!g.stock }))
    .filter((g) => g.url)
    .slice(0, MAX_GALLERY);
}

/** Merge a partial `content` object into the website, field by field. */
function applyContent(website, c) {
  const cur = website.content || {};
  const next = {};
  if (c.hero) {
    next.hero = {
      title: c.hero.title !== undefined ? str(c.hero.title, 120) : cur.hero?.title,
      subtitle: c.hero.subtitle !== undefined ? str(c.hero.subtitle, 300) : cur.hero?.subtitle,
      image: c.hero.image !== undefined ? url(c.hero.image) : cur.hero?.image,
    };
  }
  if (c.about) {
    next.about = {
      heading: c.about.heading !== undefined ? str(c.about.heading, 120) : cur.about?.heading,
      body: c.about.body !== undefined ? str(c.about.body, 5000) : cur.about?.body,
      image: c.about.image !== undefined ? url(c.about.image) : cur.about?.image,
    };
  }
  if (Array.isArray(c.highlights)) {
    next.highlights = c.highlights
      .map((h) => ({ title: str(h?.title, 80), body: str(h?.body, 300) }))
      .filter((h) => h.title || h.body)
      .slice(0, 6);
  }
  if (Array.isArray(c.amenities)) {
    next.amenities = c.amenities.map((a) => str(a, 60)).filter(Boolean).slice(0, 40);
  }
  if (c.gallery !== undefined) next.gallery = sanitizePhotos(c.gallery);
  if (c.location) {
    next.location = {
      address: c.location.address !== undefined ? str(c.location.address, 300) : cur.location?.address,
      mapQuery: c.location.mapQuery !== undefined ? str(c.location.mapQuery, 300) : cur.location?.mapQuery,
      directions: c.location.directions !== undefined ? str(c.location.directions, 2000) : cur.location?.directions,
    };
  }
  if (c.contact) {
    next.contact = {
      phone: c.contact.phone !== undefined ? str(c.contact.phone, 40) : cur.contact?.phone,
      email: c.contact.email !== undefined ? str(c.contact.email, 120) : cur.contact?.email,
      whatsapp: cur.contact?.whatsapp,
    };
  }
  if (Array.isArray(c.testimonials)) {
    next.testimonials = c.testimonials
      .map((t) => ({ quote: str(t?.quote, 600), author: str(t?.author, 80), source: str(t?.source, 40) }))
      .filter((t) => t.quote)
      .slice(0, 12);
  }
  if (c.seo) {
    next.seo = {
      title: c.seo.title !== undefined ? str(c.seo.title, 70) : cur.seo?.title,
      description: c.seo.description !== undefined ? str(c.seo.description, 170) : cur.seo?.description,
    };
  }
  for (const [k, v] of Object.entries(next)) website.set(`content.${k}`, v);
}

// @PATCH /api/website
const updateWebsite = asyncHandler(async (req, res) => {
  const property = await resolveProperty(req, res);
  const website = await Website.findOne({ propertyId: property._id });
  if (!website) {
    res.status(404);
    throw new Error("Pick a design first — then you can edit your website.");
  }
  const b = req.body || {};

  if (b.templateId !== undefined) {
    if (!TEMPLATE_IDS.includes(b.templateId)) {
      res.status(400);
      throw new Error("Unknown design");
    }
    website.templateId = b.templateId;
  }
  if (b.slug !== undefined) {
    const slug = String(b.slug).trim().toLowerCase();
    const problem = validateSlug(slug);
    if (problem) {
      res.status(400);
      throw new Error(problem);
    }
    if (await Website.exists({ slug, _id: { $ne: website._id } })) {
      res.status(409);
      throw new Error("That address is already taken — try another.");
    }
    website.slug = slug;
  }
  if (b.whatsappNumber !== undefined) {
    const wa = normalizeWhatsapp(b.whatsappNumber, property.country);
    if (b.whatsappNumber && !wa) {
      res.status(400);
      throw new Error("That WhatsApp number doesn't look right — include your country code, e.g. +62 812 3456 7890.");
    }
    website.whatsappNumber = wa;
    website.set("content.contact.whatsapp", wa);
    if (wa && !website.content?.contact?.phone) website.set("content.contact.phone", `+${wa}`);
    // A hotel with no phone on file gets the WhatsApp number as its contact.
    if (wa && !property.phone) {
      await Property.updateOne({ _id: property._id }, { $set: { phone: `+${wa}` } });
    }
  }
  if (b.published !== undefined) website.published = !!b.published;
  if (b.accent !== undefined) {
    website.accent = /^#[0-9a-f]{6}$/i.test(String(b.accent)) ? String(b.accent) : "";
  }
  if (b.content && typeof b.content === "object") applyContent(website, b.content);
  if (Array.isArray(b.roomOverrides)) {
    website.roomOverrides = b.roomOverrides
      .filter((o) => o && o.roomTypeId)
      .map((o) => ({
        roomTypeId: o.roomTypeId,
        hidden: !!o.hidden,
        description: str(o.description, 1500),
        image: url(o.image),
      }))
      .slice(0, 100);
  }

  try {
    await website.save();
  } catch (err) {
    if (err.code === 11000) {
      res.status(409);
      throw new Error("That address is already taken — try another.");
    }
    if (err.name === "ValidationError" || err.name === "CastError") {
      res.status(400);
      throw new Error("Some of those changes weren't valid — please check and try again.");
    }
    throw err;
  }
  const rooms = await roomsOf(property);
  res.json(payload(website, property, rooms));
});

// @GET /api/website/slug-check?slug=
const checkSlug = asyncHandler(async (req, res) => {
  const slug = String(req.query.slug || "").trim().toLowerCase();
  const problem = validateSlug(slug);
  if (problem) return res.json({ success: true, available: false, message: problem });
  const property = await Property.findOne({ workspaceId: req.workspace._id }).sort({ createdAt: 1 });
  const mine = property ? await Website.findOne({ propertyId: property._id }).select("_id") : null;
  const q = { slug };
  if (mine) q._id = { $ne: mine._id };
  const taken = await Website.exists(q);
  res.json({
    success: true,
    available: !taken,
    message: taken ? "That address is already taken." : "Available",
  });
});

// @POST /api/website/photo (multipart "file") → { url }
const uploadPhoto = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error("No image file provided");
  }
  const { uploadBuffer } = require("../services/cloudinaryService");
  const result = await uploadBuffer(req.file.buffer, {
    folder: "websites",
    resource_type: "image",
  });
  res.json({ success: true, url: result.secure_url, publicId: result.public_id });
});

// ─── Public ─────────────────────────────────────────────────────────────────

// @GET /api/public/site/:slug
const getPublicSite = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  const website = SLUG_RE.test(slug) ? await Website.findOne({ slug }) : null;
  const property = website
    ? await Property.findOne({ _id: website.propertyId, active: true })
    : null;
  if (!website || !property || website.published === false) {
    res.status(404);
    throw new Error("This website isn't available");
  }
  const rooms = await roomsOf(property);
  res.set("Cache-Control", "public, max-age=60");
  res.json({ success: true, site: buildSite(website, property, rooms) });
});

module.exports = {
  getWebsite,
  getDraft,
  generateWebsite,
  updateWebsite,
  checkSlug,
  uploadPhoto,
  getPublicSite,
  validateSlug,
  uniqueSlug,
};
