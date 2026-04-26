/**
 * Botlify — Link in Bio controller
 * CRUD for a workspace's public link page + public read/click tracking.
 */
const asyncHandler = require("express-async-handler");
const LinkInBio = require("../models/LinkInBio");

// PUBLIC: GET /api/public/bio/:slug
exports.getPublic = asyncHandler(async (req, res) => {
  const page = await LinkInBio.findOne({
    slug: req.params.slug.toLowerCase(),
    enabled: true,
  }).lean();
  if (!page) return res.status(404).json({ message: "Not found" });
  // Increment view (fire and forget)
  LinkInBio.updateOne({ _id: page._id }, { $inc: { totalViews: 1 } }).catch(
    () => {},
  );
  // Return only enabled links, sorted
  page.links = (page.links || [])
    .filter((l) => l.enabled)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  delete page.workspaceId;
  res.json({ success: true, page });
});

// PUBLIC: POST /api/public/bio/:slug/click/:linkId
exports.trackClick = asyncHandler(async (req, res) => {
  await LinkInBio.updateOne(
    { slug: req.params.slug.toLowerCase(), "links._id": req.params.linkId },
    { $inc: { "links.$.clicks": 1 } },
  );
  res.json({ success: true });
});

// AUTH: GET /api/bio
exports.get = asyncHandler(async (req, res) => {
  const page = await LinkInBio.findOne({ workspaceId: req.workspace._id });
  res.json({ success: true, page });
});

// AUTH: POST /api/bio
exports.createOrUpdate = asyncHandler(async (req, res) => {
  const {
    slug,
    displayName,
    bio,
    avatarUrl,
    theme,
    accentColor,
    links,
    enabled,
  } = req.body;

  let page = await LinkInBio.findOne({ workspaceId: req.workspace._id });

  if (!page) {
    if (!slug) return res.status(400).json({ message: "slug required" });
    const exists = await LinkInBio.findOne({ slug: slug.toLowerCase() });
    if (exists) return res.status(409).json({ message: "Slug taken" });
    page = await LinkInBio.create({
      workspaceId: req.workspace._id,
      slug: slug.toLowerCase(),
      displayName,
      bio,
      avatarUrl,
      theme,
      accentColor,
      links: links || [],
      enabled: enabled !== false,
    });
    return res.status(201).json({ success: true, page });
  }

  // Update: only allow slug change if new slug is free
  if (slug && slug.toLowerCase() !== page.slug) {
    const exists = await LinkInBio.findOne({ slug: slug.toLowerCase() });
    if (exists) return res.status(409).json({ message: "Slug taken" });
    page.slug = slug.toLowerCase();
  }
  if (displayName !== undefined) page.displayName = displayName;
  if (bio !== undefined) page.bio = bio;
  if (avatarUrl !== undefined) page.avatarUrl = avatarUrl;
  if (theme !== undefined) page.theme = theme;
  if (accentColor !== undefined) page.accentColor = accentColor;
  if (Array.isArray(links)) page.links = links;
  if (enabled !== undefined) page.enabled = enabled;
  await page.save();
  res.json({ success: true, page });
});

// AUTH: DELETE /api/bio
exports.remove = asyncHandler(async (req, res) => {
  await LinkInBio.deleteOne({ workspaceId: req.workspace._id });
  res.json({ success: true });
});
