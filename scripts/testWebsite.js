/**
 * Hotel websites — generated from the hotel's own data, editable, public.
 *
 * Proves: a site is generated from the property + rooms (copy, stock photos,
 * WhatsApp normalised, booking link); the draft preview doesn't save; edits
 * (content, gallery, template, slug, WhatsApp) take effect and bad ones are
 * refused; regenerate keeps the hotelier's own photos; the public endpoint
 * serves it live with room prices read from RoomType, and 404s when
 * unpublished or unknown.
 *
 * Run: node scripts/testWebsite.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

let pass = 0,
  fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log("  PASS  " + label);
  } else {
    fail++;
    console.log("  FAIL  " + label);
  }
};

const call = (handler, { body = {}, params = {}, query = {}, workspace }) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      set() {
        return this;
      },
      json(d) {
        resolve({ status: this.statusCode, ...d });
      },
    };
    handler({ body, params, query, workspace }, res, (err) =>
      resolve({ status: res.statusCode, error: err && err.message }),
    );
  });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Workspace = require("../src/models/Workspace");
  const Property = require("../src/models/Property");
  const RoomType = require("../src/models/RoomType");
  const Website = require("../src/models/Website");
  const c = require("../src/controllers/websiteController");

  const made = { ws: [], prop: [], rooms: [], sites: [] };
  try {
    const ws = await Workspace.create({
      name: "Website Test " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
      features: { hotelBookings: true },
    });
    made.ws.push(ws._id);
    const workspace = { _id: ws._id };

    // No property yet → a clear 404, not a crash.
    const none = await call(c.getWebsite, { workspace });
    ok(none.status === 404, "no property → 404 with a message");

    const uniq = Date.now().toString(36);
    const prop = await Property.create({
      workspaceId: ws._id,
      name: `Villa Kemuning ${uniq}`,
      propertyType: "villa",
      city: "Ubud",
      country: "Indonesia",
      address: "Jl. Raya Sayan 8",
      currency: "IDR",
    });
    made.prop.push(prop._id);
    const r1 = await RoomType.create({
      workspaceId: ws._id, propertyId: prop._id, name: "Garden Suite",
      baseRate: 1200000, currency: "IDR", maxOccupancy: 2, unitsCount: 2,
    });
    const r2 = await RoomType.create({
      workspaceId: ws._id, propertyId: prop._id, name: "Pool Villa",
      baseRate: 2500000, currency: "IDR", maxOccupancy: 4, unitsCount: 1,
      photos: [{ url: "https://example.com/pool-villa.jpg" }],
    });
    made.rooms.push(r1._id, r2._id);

    const empty = await call(c.getWebsite, { workspace });
    ok(empty.status === 200 && empty.website === null, "GET before generate → website null");

    const draft = await call(c.getDraft, { workspace, query: { templateId: "noir" } });
    ok(draft.site && draft.site.templateId === "noir", "draft previews with the requested template");
    ok(draft.site.rooms.length === 2, "draft carries both rooms");
    ok(!(await Website.exists({ propertyId: prop._id })), "draft does not save anything");

    // Bad WhatsApp number is refused.
    const badWa = await call(c.generateWebsite, {
      workspace, body: { templateId: "tropic", whatsappNumber: "12" },
    });
    ok(badWa.status === 400, "generate with an invalid WhatsApp number → 400");

    const gen = await call(c.generateWebsite, {
      workspace, body: { templateId: "tropic", whatsappNumber: "0812 3456 7890" },
    });
    ok(gen.status === 201 && gen.website, "generate creates the website");
    made.sites.push(gen.website._id);
    const site = gen.site;
    ok(site.templateId === "tropic", "template saved");
    ok(site.whatsapp === "6281234567890", "local Indonesian number → 62… international");
    ok(/^villa-kemuning/.test(site.slug), "slug derived from the hotel name: " + site.slug);
    ok(site.content.hero.title === prop.name, "hero title is the hotel name");
    ok(/Ubud/.test(site.content.hero.subtitle), "hero subtitle mentions the city");
    ok(site.content.about.body.length > 100, "about copy written");
    ok(site.content.gallery.length === 1 && !site.content.gallery[0].stock,
      "gallery uses the hotel's own (room) photo when it has one");
    ok(site.content.amenities.length >= 5, "villa default amenities filled");
    ok(site.content.testimonials.length === 0, "no invented testimonials");
    ok(/^\/book\/.+/.test(site.bookingUrl || ""), "booking link points at /book/<slug>");
    ok(site.rooms[0].name === "Garden Suite" && site.rooms[0].price === 1200000,
      "rooms read live, cheapest first, with price");
    ok(/images\.unsplash\.com/.test(site.rooms[0].image), "room without photos gets a stock photo");
    ok(site.rooms[1].image === "https://example.com/pool-villa.jpg", "room with a photo uses its own");
    const propAfter = await Property.findById(prop._id);
    ok(propAfter.phone === "+6281234567890", "empty property phone filled from WhatsApp");

    // Edits
    const upd = await call(c.updateWebsite, {
      workspace,
      body: {
        templateId: "heritage",
        content: {
          hero: { subtitle: "Quiet luxury above the Ayung river" },
          gallery: [
            { url: "https://example.com/a.jpg", caption: "Pool" },
            "https://example.com/b.jpg",
            { url: "javascript:alert(1)" },
          ],
          testimonials: [{ quote: "Best stay in Bali", author: "Anna", source: "Google" }],
        },
        roomOverrides: [{ roomTypeId: r2._id, description: "Our best villa", hidden: false }],
      },
    });
    ok(upd.status === 200, "update OK");
    ok(upd.site.templateId === "heritage", "template switched");
    ok(upd.site.content.hero.subtitle === "Quiet luxury above the Ayung river", "hero subtitle edited");
    ok(upd.site.content.hero.title === prop.name, "untouched hero title kept");
    ok(upd.site.content.gallery.length === 2, "gallery replaced; non-http URL dropped");
    ok(upd.site.content.testimonials.length === 1, "testimonial added");
    ok(upd.site.rooms.find((r) => r.name === "Pool Villa").description === "Our best villa",
      "room description override applied");

    const badSlug = await call(c.updateWebsite, { workspace, body: { slug: "Bad Slug!" } });
    ok(badSlug.status === 400, "invalid slug → 400");
    const reserved = await call(c.updateWebsite, { workspace, body: { slug: "dashboard" } });
    ok(reserved.status === 400, "reserved slug → 400");
    const newSlug = `kemuning-${uniq}`;
    const goodSlug = await call(c.updateWebsite, { workspace, body: { slug: newSlug } });
    ok(goodSlug.status === 200 && goodSlug.site.slug === newSlug, "slug changed");
    const avail = await call(c.checkSlug, { workspace, query: { slug: newSlug } });
    ok(avail.available === true, "own slug reads as available to its owner");

    // Hiding a room removes it from the site.
    const hid = await call(c.updateWebsite, {
      workspace, body: { roomOverrides: [{ roomTypeId: r1._id, hidden: true }] },
    });
    ok(hid.site.rooms.length === 1, "hidden room not shown");

    // Regenerate keeps own photos and testimonials.
    const regen = await call(c.generateWebsite, { workspace, body: {} });
    ok(regen.status === 201, "regenerate OK");
    ok(regen.site.content.gallery.length === 2 &&
      regen.site.content.gallery[0].url === "https://example.com/a.jpg",
      "regenerate keeps the hotelier's photos");
    ok(regen.site.content.testimonials.length === 1, "regenerate keeps testimonials");
    ok(regen.site.content.hero.subtitle !== "Quiet luxury above the Ayung river",
      "regenerate rewrites the copy");
    ok(regen.site.whatsapp === "6281234567890", "regenerate keeps WhatsApp");

    // Public
    const pub = await call(c.getPublicSite, { params: { slug: newSlug } });
    ok(pub.status === 200 && pub.site.hotel.name === prop.name, "public site served by slug");
    ok(!pub.site.workspaceId && !pub.site.propertyId, "public payload has no internal ids");
    await RoomType.updateOne({ _id: r2._id }, { $set: { baseRate: 2750000 } });
    const pub2 = await call(c.getPublicSite, { params: { slug: newSlug } });
    ok(pub2.site.rooms.find((r) => r.name === "Pool Villa").price === 2750000,
      "public room price follows RoomType live");
    const missing = await call(c.getPublicSite, { params: { slug: "no-such-hotel-" + uniq } });
    ok(missing.status === 404, "unknown slug → 404");
    await call(c.updateWebsite, { workspace, body: { published: false } });
    const unpub = await call(c.getPublicSite, { params: { slug: newSlug } });
    ok(unpub.status === 404, "unpublished site → 404");

    // A second hotel can't take the same slug.
    const ws2 = await Workspace.create({
      name: "Website Test B " + Date.now(),
      owner: new mongoose.Types.ObjectId(),
      industry: "hospitality",
    });
    made.ws.push(ws2._id);
    const prop2 = await Property.create({
      workspaceId: ws2._id, name: `Villa Kemuning ${uniq}`, propertyType: "hotel", city: "Ubud",
    });
    made.prop.push(prop2._id);
    const gen2 = await call(c.generateWebsite, { workspace: { _id: ws2._id }, body: { templateId: "urban" } });
    ok(gen2.status === 201, "second hotel generates");
    made.sites.push(gen2.website._id);
    ok((await c.uniqueSlug(newSlug)) !== newSlug, "a taken slug is never handed out again");
    ok(gen2.site.content.gallery.every((g) => g.stock) && gen2.site.content.gallery.length === 8,
      "hotel without photos gets 8 stock photos");
    const clash = await call(c.updateWebsite, { workspace: { _id: ws2._id }, body: { slug: newSlug } });
    ok(clash.status === 409, "taking another hotel's slug → 409");
  } catch (err) {
    fail++;
    console.error("  ERROR", err);
  } finally {
    await Website.deleteMany({ _id: { $in: made.sites } });
    await Website.deleteMany({ propertyId: { $in: made.prop } });
    await RoomType.deleteMany({ propertyId: { $in: made.prop } });
    await Property.deleteMany({ _id: { $in: made.prop } });
    await Workspace.deleteMany({ _id: { $in: made.ws } });
    await mongoose.disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
