/**
 * trainingController — "Train your AI": everything the AI needs to look after
 * guests on its own.
 *
 *   GET    /api/training            → questions, contacts, behaviour, readiness
 *   POST   /api/training            → add a question
 *   PATCH  /api/training/:id        → edit a question
 *   DELETE /api/training/:id        → delete a question
 *   POST   /api/training/reset      → restore the default questions
 *   PUT    /api/training/contacts   → save the contacts directory
 *   PUT    /api/training/playbook   → save "how your AI behaves"
 *   GET    /api/training/readiness  → what's still missing (for the reminder)
 *   POST   /api/training/test       → ask the AI, get its real reply
 *
 * All of it lives on workspace.aiSettings, which the AI reads on every reply:
 * answered questions (a close match is sent word for word), the contacts it may
 * point guests to, and the behaviour rules. Editing here changes what guests
 * are told — immediately.
 *
 * Writes use targeted $push / $set / $pull on one field at a time.
 * PUT /workspaces/:id replaces aiSettings wholesale, so an editor built on it
 * could wipe unrelated settings.
 */
const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Workspace = require("../models/Workspace");
const Property = require("../models/Property");
const ai = require("../services/ai");
const {
  CATEGORIES,
  CONTACT_ROLES,
  defaultHotelFaqs,
  defaultPlaybook,
} = require("../config/hotelFaqs");
const logger = require("../utils/logger");

// Bump when the default knowledge grows; existing hotels get the new questions
// merged in on their next visit, with their own edits left alone.
const KNOWLEDGE_VERSION = 2;
const MAX_FAQS = 400;
const MAX_Q = 300;
const MAX_A = 2000;
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));
const ROLE_KEYS = new Set(CONTACT_ROLES.map((r) => r.key));

const norm = (q) =>
  String(q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function cleanFaq(body = {}) {
  const question = String(body.question || "").trim().slice(0, MAX_Q);
  const answer = String(body.answer || "").trim().slice(0, MAX_A);
  const category = CATEGORY_KEYS.has(body.category) ? body.category : "general";
  return { question, answer, category };
}

async function primaryProperty(workspaceId) {
  return Property.findOne({ workspaceId, active: true }).sort({ createdAt: 1 }).lean();
}

/** What the AI still needs before it can run the front desk on its own. */
function readinessOf(aiSettings = {}) {
  const faqs = aiSettings.faqs || [];
  const contacts = aiSettings.contacts || [];
  const missingAnswers = faqs
    .filter((f) => f.required && !String(f.answer || "").trim())
    .map((f) => ({ id: f._id, question: f.question, category: f.category }));
  const missingContacts = CONTACT_ROLES.filter((r) => r.required)
    .filter((r) => {
      const c = contacts.find((x) => x.role === r.key);
      return !c || !String(c.whatsapp || "").trim();
    })
    .map((r) => ({ role: r.key, label: r.label }));

  const requiredTotal =
    faqs.filter((f) => f.required).length +
    CONTACT_ROLES.filter((r) => r.required).length;
  const missing = missingAnswers.length + missingContacts.length;
  const answered = faqs.filter((f) => String(f.answer || "").trim()).length;

  return {
    complete: missing === 0,
    percent: requiredTotal
      ? Math.round(((requiredTotal - missing) / requiredTotal) * 100)
      : 100,
    missingAnswers,
    missingContacts,
    answered,
    total: faqs.length,
  };
}

/**
 * First visit: seed everything. Later visits on an older knowledge version:
 * add the new default questions, file old ones under the right topic, and
 * never overwrite an answer the hotelier wrote.
 */
async function ensureKnowledge(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select("aiSettings");
  const s = ws.aiSettings || {};
  if ((s.knowledgeVersion || 0) >= KNOWLEDGE_VERSION) return;

  const property = await primaryProperty(workspaceId);
  const defaults = defaultHotelFaqs(property || {});
  const current = (s.faqs || []).map((f) => f.toObject?.() || f);

  let faqs;
  if (!s.faqsSeeded && !current.length) {
    faqs = defaults;
  } else {
    const byQ = new Map(defaults.map((d) => [norm(d.question), d]));
    // Existing entries keep their answers; gain a topic + required flag.
    faqs = current.map((f) => {
      const d = byQ.get(norm(f.question));
      return d
        ? { ...f, category: f.category && f.category !== "general" ? f.category : d.category, required: d.required }
        : f;
    });
    const have = new Set(faqs.map((f) => norm(f.question)));
    for (const d of defaults) if (!have.has(norm(d.question))) faqs.push(d);
  }

  const update = {
    "aiSettings.faqs": faqs,
    "aiSettings.faqsSeeded": true,
    "aiSettings.knowledgeVersion": KNOWLEDGE_VERSION,
  };
  if (!(s.playbook || []).length) update["aiSettings.playbook"] = defaultPlaybook();
  await Workspace.updateOne({ _id: workspaceId }, { $set: update });
  logger.info(`[training] knowledge v${KNOWLEDGE_VERSION} ready ws=${workspaceId}`);
}

async function payload(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select("aiSettings");
  const s = ws.aiSettings || {};
  return {
    faqs: s.faqs || [],
    contacts: s.contacts || [],
    playbook: s.playbook || [],
    categories: CATEGORIES,
    roles: CONTACT_ROLES,
    readiness: readinessOf(s),
  };
}

// @GET /api/training
const listFaqs = asyncHandler(async (req, res) => {
  await ensureKnowledge(req.workspace._id);
  res.json({ success: true, ...(await payload(req.workspace._id)) });
});

// @GET /api/training/readiness
const getReadiness = asyncHandler(async (req, res) => {
  await ensureKnowledge(req.workspace._id);
  const ws = await Workspace.findById(req.workspace._id).select("aiSettings");
  res.json({ success: true, readiness: readinessOf(ws.aiSettings || {}) });
});

// @POST /api/training
const addFaq = asyncHandler(async (req, res) => {
  const faq = cleanFaq(req.body);
  if (!faq.question || !faq.answer) {
    res.status(400);
    throw new Error("Add both a question and an answer.");
  }
  const ws = await Workspace.findById(req.workspace._id).select("aiSettings.faqs");
  if ((ws.aiSettings?.faqs || []).length >= MAX_FAQS) {
    res.status(400);
    throw new Error(`You can save up to ${MAX_FAQS} questions.`);
  }
  await Workspace.updateOne(
    { _id: req.workspace._id },
    {
      $push: { "aiSettings.faqs": { $each: [faq], $position: 0 } },
      $set: { "aiSettings.faqsSeeded": true },
    },
  );
  res.status(201).json({ success: true, ...(await payload(req.workspace._id)) });
});

// @PATCH /api/training/:id
// An empty answer is allowed — it means "the AI shouldn't answer this yet".
const updateFaq = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404);
    throw new Error("That question wasn't found.");
  }
  const faq = cleanFaq(req.body);
  if (!faq.question) {
    res.status(400);
    throw new Error("The question can't be empty.");
  }
  const set = {
    "aiSettings.faqs.$.question": faq.question,
    "aiSettings.faqs.$.answer": faq.answer,
  };
  if (req.body?.category && CATEGORY_KEYS.has(req.body.category)) {
    set["aiSettings.faqs.$.category"] = faq.category;
  }
  const result = await Workspace.updateOne(
    { _id: req.workspace._id, "aiSettings.faqs._id": req.params.id },
    { $set: set },
  );
  if (!result.matchedCount) {
    res.status(404);
    throw new Error("That question wasn't found.");
  }
  res.json({ success: true, ...(await payload(req.workspace._id)) });
});

// @DELETE /api/training/:id
const deleteFaq = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404);
    throw new Error("That question wasn't found.");
  }
  await Workspace.updateOne(
    { _id: req.workspace._id },
    { $pull: { "aiSettings.faqs": { _id: req.params.id } } },
  );
  res.json({ success: true, ...(await payload(req.workspace._id)) });
});

// @POST /api/training/reset
const resetFaqs = asyncHandler(async (req, res) => {
  const property = await primaryProperty(req.workspace._id);
  await Workspace.updateOne(
    { _id: req.workspace._id },
    {
      $set: {
        "aiSettings.faqs": defaultHotelFaqs(property || {}),
        "aiSettings.faqsSeeded": true,
        "aiSettings.knowledgeVersion": KNOWLEDGE_VERSION,
      },
    },
  );
  res.json({ success: true, ...(await payload(req.workspace._id)) });
});

// @PUT /api/training/contacts   Body: { contacts: [...] }
const saveContacts = asyncHandler(async (req, res) => {
  const list = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  const contacts = list
    .filter((c) => c && ROLE_KEYS.has(c.role))
    .map((c) => ({
      role: c.role,
      name: String(c.name || "").trim().slice(0, 120),
      whatsapp: String(c.whatsapp || "").trim().slice(0, 30),
      email: String(c.email || "").trim().toLowerCase().slice(0, 160),
      availability: String(c.availability || "").trim().slice(0, 120),
      shareWithGuests: !!c.shareWithGuests,
      notes: String(c.notes || "").trim().slice(0, 300),
    }))
    // Keep a row only if something was filled in.
    .filter((c) => c.name || c.whatsapp || c.email)
    .slice(0, 50);
  for (const c of contacts) {
    if (c.whatsapp && !/^\+?[0-9 ()-]{6,20}$/.test(c.whatsapp)) {
      res.status(400);
      throw new Error(`The number for "${c.name || c.role}" doesn't look right. Use the full international number.`);
    }
  }
  await Workspace.updateOne(
    { _id: req.workspace._id },
    { $set: { "aiSettings.contacts": contacts } },
  );
  res.json({ success: true, ...(await payload(req.workspace._id)) });
});

// @PUT /api/training/playbook   Body: { playbook: [{situation, response}] }
const savePlaybook = asyncHandler(async (req, res) => {
  const list = Array.isArray(req.body?.playbook) ? req.body.playbook : [];
  const playbook = list
    .map((p) => ({
      situation: String(p?.situation || "").trim().slice(0, 200),
      response: String(p?.response || "").trim().slice(0, 1000),
    }))
    .filter((p) => p.situation && p.response)
    .slice(0, 60);
  await Workspace.updateOne(
    { _id: req.workspace._id },
    { $set: { "aiSettings.playbook": playbook } },
  );
  res.json({ success: true, ...(await payload(req.workspace._id)) });
});

// @POST /api/training/test   Body: { message, history? }
// The REAL reply logic against the saved training. Nothing sent, nothing stored.
const testAi = asyncHandler(async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) {
    res.status(400);
    throw new Error("Type a question to test.");
  }
  const ws = await Workspace.findById(req.workspace._id);
  const history = Array.isArray(req.body?.history)
    ? req.body.history
        .filter((m) => m && m.role && m.content)
        .slice(-12)
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content).slice(0, 2000),
        }))
    : [];

  const result = await ai.generateReply({
    workspace: ws,
    history,
    userMessage: message.slice(0, 2000),
    contact: { name: "Guest", igUsername: "guest" },
    channel: "whatsapp",
  });

  res.json({
    success: true,
    reply: result?.reply || "",
    fromTraining: result?.provider === "faq",
    escalate: !!result?.escalate,
  });
});

module.exports = {
  listFaqs,
  getReadiness,
  addFaq,
  updateFaq,
  deleteFaq,
  resetFaqs,
  saveContacts,
  savePlaybook,
  testAi,
  readinessOf,
  KNOWLEDGE_VERSION,
};
