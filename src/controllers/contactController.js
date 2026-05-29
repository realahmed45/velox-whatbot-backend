const asyncHandler = require("express-async-handler");
const Contact = require("../models/Contact");
const Conversation = require("../models/Conversation");
const { Parser } = require("@json2csv/plainjs");

// @GET /api/contacts — List contacts
const getContacts = asyncHandler(async (req, res) => {
  const {
    search,
    tag,
    page = 1,
    limit = 50,
    sortBy = "lastSeenAt",
    sortOrder = "desc",
  } = req.query;
  const filter = { workspaceId: req.workspace._id, isDeleted: false };

  if (tag) filter.tags = tag;
  if (req.query.status) filter.status = req.query.status;

  // Channel scoping: WhatsApp contacts have a phone, Instagram contacts have
  // an igUserId. We use presence of those identifiers to scope the list to
  // the active channel without needing a denormalised channel column.
  const { channel } = req.query;
  if (channel === "whatsapp") filter.phone = { $type: "string" };
  else if (channel === "instagram") filter.igUserId = { $type: "string" };

  let query = Contact.find(filter)
    .sort({ [sortBy]: sortOrder === "asc" ? 1 : -1 })
    .limit(parseInt(limit))
    .skip((parseInt(page) - 1) * parseInt(limit));

  const [contacts, total] = await Promise.all([
    query.exec(),
    Contact.countDocuments(filter),
  ]);

  let results = contacts;
  if (search) {
    const s = search.toLowerCase();
    results = contacts.filter(
      (c) =>
        c.phone?.includes(s) ||
        c.name?.toLowerCase().includes(s) ||
        c.email?.toLowerCase().includes(s),
    );
  }

  res.json({ success: true, contacts: results, total, page: parseInt(page) });
});

// @GET /api/contacts/:id — Get single contact with conversation history
const getContact = asyncHandler(async (req, res) => {
  const contact = await Contact.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
    isDeleted: false,
  });
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }

  const conversations = await Conversation.find({ contactId: contact._id })
    .sort({ lastMessageAt: -1 })
    .limit(10)
    .select("status lastMessageAt lastMessagePreview");

  res.json({ success: true, contact, conversations });
});

// @PUT /api/contacts/:id — Update contact
const updateContact = asyncHandler(async (req, res) => {
  const { name, email, tags, notes, customFields, status } = req.body;
  const contact = await Contact.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
    isDeleted: false,
  });
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }

  if (name !== undefined) contact.name = name;
  if (email !== undefined) contact.email = email;
  if (tags !== undefined)
    contact.tags = tags.map((t) => t.toLowerCase().trim());
  if (customFields !== undefined) contact.customFields = customFields;
  if (
    status !== undefined &&
    ["new", "active", "customer", "lost"].includes(status)
  ) {
    contact.status = status;
  }
  if (notes) {
    contact.notes.push({ content: notes, addedBy: req.user._id });
  }

  await contact.save();
  res.json({ success: true, contact });
});

// @DELETE /api/contacts/:id — GDPR-style deletion
const deleteContact = asyncHandler(async (req, res) => {
  const contact = await Contact.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }

  // Soft delete — anonymize PII
  contact.isDeleted = true;
  contact.deletedAt = new Date();
  contact.name = "[Deleted]";
  contact.email = null;
  contact.phone = `deleted_${contact._id}`;
  contact.variables = new Map();
  contact.notes = [];
  await contact.save();

  res.json({ success: true, message: "Contact data removed" });
});

// @GET /api/contacts/export — Export contacts as CSV
const exportContacts = asyncHandler(async (req, res) => {
  const contacts = await Contact.find({
    workspaceId: req.workspace._id,
    isDeleted: false,
  })
    .select("phone name email tags firstSeenAt lastSeenAt messageCount")
    .lean();

  const fields = [
    "phone",
    "name",
    "email",
    "tags",
    "firstSeenAt",
    "lastSeenAt",
    "messageCount",
  ];
  const data = contacts.map((c) => ({
    ...c,
    tags: c.tags?.join(", "),
    firstSeenAt: c.firstSeenAt?.toISOString(),
    lastSeenAt: c.lastSeenAt?.toISOString(),
  }));

  const parser = new Parser({ fields });
  const csv = parser.parse(data);

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="contacts.csv"');
  res.send(csv);
});

// @POST /api/contacts/import — Import contacts from CSV
const importContacts = asyncHandler(async (req, res) => {
  const { contacts } = req.body; // array of { phone, name, email, tags }
  if (!Array.isArray(contacts) || !contacts.length) {
    res.status(400);
    throw new Error("contacts array required");
  }

  let created = 0,
    skipped = 0;
  for (const c of contacts) {
    if (!c.phone) {
      skipped++;
      continue;
    }
    try {
      await Contact.findOneAndUpdate(
        { workspaceId: req.workspace._id, phone: c.phone },
        {
          $setOnInsert: { firstSeenAt: new Date() },
          $set: { name: c.name, email: c.email, lastSeenAt: new Date() },
          $addToSet: { tags: { $each: c.tags || [] } },
        },
        { upsert: true, new: true },
      );
      created++;
    } catch {
      skipped++;
    }
  }

  res.json({ success: true, created, skipped, total: contacts.length });
});

// @POST /api/contacts/:id/tags — Add tag to contact
const addTag = asyncHandler(async (req, res) => {
  const { tag } = req.body;
  if (!tag) {
    res.status(400);
    throw new Error("Tag required");
  }
  const contact = await Contact.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { $addToSet: { tags: tag.toLowerCase().trim() } },
    { new: true },
  );
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }
  res.json({ success: true, contact });
});

// @DELETE /api/contacts/:id/tags/:tag — Remove tag
const removeTag = asyncHandler(async (req, res) => {
  const tag = String(req.params.tag || "")
    .toLowerCase()
    .trim();
  const contact = await Contact.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { $pull: { tags: tag } },
    { new: true },
  );
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }
  res.json({ success: true, contact });
});

// @POST /api/contacts/:id/opt-out — Mark contact as opted out
const optOutContact = asyncHandler(async (req, res) => {
  const contact = await Contact.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { $set: { optedOut: true, optedOutAt: new Date() } },
    { new: true },
  );
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }
  res.json({ success: true, contact });
});

// @POST /api/contacts/:id/opt-in — Re-subscribe
const optInContact = asyncHandler(async (req, res) => {
  const contact = await Contact.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { $set: { optedOut: false, optedOutAt: null, optedIn: true } },
    { new: true },
  );
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }
  res.json({ success: true, contact });
});

// @POST /api/contacts/:id/notes — Add a note
const addNote = asyncHandler(async (req, res) => {
  const { content } = req.body;
  if (!content) {
    res.status(400);
    throw new Error("content required");
  }
  const contact = await Contact.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!contact) {
    res.status(404);
    throw new Error("Contact not found");
  }
  contact.notes.push({ content, addedBy: req.user._id });
  await contact.save();
  res.json({ success: true, contact });
});

// @POST /api/contacts — Manually add a contact
const createContact = asyncHandler(async (req, res) => {
  const { name, username, email, phone, tags, source } = req.body;
  if (!username && !phone) {
    res.status(400);
    throw new Error("An Instagram username or phone number is required");
  }

  const igUsername = username
    ? String(username).trim().replace(/^@/, "")
    : undefined;

  // Avoid duplicates within the workspace.
  if (igUsername) {
    const existing = await Contact.findOne({
      workspaceId: req.workspace._id,
      igUsername,
      isDeleted: false,
    });
    if (existing) {
      res.status(409);
      throw new Error("A contact with that username already exists");
    }
  }

  const contact = await Contact.create({
    workspaceId: req.workspace._id,
    name: name || igUsername || "New Contact",
    igUsername,
    username: igUsername,
    // Manual contacts have no real IG user id yet — namespace a placeholder so
    // the unique igUserId lookups in the engine never collide.
    igUserId: igUsername ? `manual:${igUsername}` : undefined,
    email: email || undefined,
    phone: phone || undefined,
    tags: Array.isArray(tags)
      ? tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
      : [],
    source: source || "manual",
    status: "new",
  });

  res.status(201).json({ success: true, contact });
});

module.exports = {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  exportContacts,
  importContacts,
  addTag,
  removeTag,
  optOutContact,
  optInContact,
  addNote,
};
