/**
 * trainingController — "Train your AI": the hotel's own question-and-answer
 * knowledge base, and a sandbox to test the AI against it.
 *
 *   GET    /api/training          → the Q&As (seeds the 20 defaults on first visit)
 *   POST   /api/training          → add one
 *   PATCH  /api/training/:id      → edit one
 *   DELETE /api/training/:id      → delete one
 *   POST   /api/training/reset    → put the 20 defaults back
 *   POST   /api/training/test     → ask the AI a question, get its real reply
 *
 * The Q&As live on workspace.aiSettings.faqs, which the AI already reads in two
 * ways: a close match is answered with the hotelier's exact wording, and every
 * Q&A goes into the AI's instructions so it can answer paraphrased questions
 * too. So editing here changes what guests are told — immediately.
 *
 * These endpoints edit the array with atomic $push / $set / $pull rather than
 * rewriting aiSettings. PUT /workspaces/:id replaces aiSettings wholesale,
 * which would let a stale editor wipe unrelated settings.
 */
const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Workspace = require("../models/Workspace");
const Property = require("../models/Property");
const ai = require("../services/ai");
const { defaultHotelFaqs } = require("../config/hotelFaqs");
const logger = require("../utils/logger");

const MAX_FAQS = 100;
const MAX_Q = 300;
const MAX_A = 2000;

function clean(body = {}) {
  const question = String(body.question || "").trim().slice(0, MAX_Q);
  const answer = String(body.answer || "").trim().slice(0, MAX_A);
  return { question, answer };
}

async function primaryProperty(workspaceId) {
  return Property.findOne({ workspaceId, active: true })
    .sort({ createdAt: 1 })
    .lean();
}

async function readFaqs(workspaceId) {
  const ws = await Workspace.findById(workspaceId).select("aiSettings.faqs");
  return ws?.aiSettings?.faqs || [];
}

// @GET /api/training
const listFaqs = asyncHandler(async (req, res) => {
  const ws = await Workspace.findById(req.workspace._id).select(
    "aiSettings.faqs aiSettings.faqsSeeded",
  );

  // First visit: hand them the 20 questions every hotel gets asked, already
  // answered, so they start by editing rather than staring at an empty page.
  // Only once — a hotelier who deletes them all keeps an empty list.
  if (!ws.aiSettings?.faqsSeeded && !(ws.aiSettings?.faqs || []).length) {
    const property = await primaryProperty(req.workspace._id);
    await Workspace.updateOne(
      { _id: req.workspace._id },
      {
        $set: {
          "aiSettings.faqs": defaultHotelFaqs(property || {}),
          "aiSettings.faqsSeeded": true,
        },
      },
    );
    logger.info(`[training] seeded default Q&As ws=${req.workspace._id}`);
  } else if (!ws.aiSettings?.faqsSeeded) {
    await Workspace.updateOne(
      { _id: req.workspace._id },
      { $set: { "aiSettings.faqsSeeded": true } },
    );
  }

  res.json({ success: true, faqs: await readFaqs(req.workspace._id) });
});

// @POST /api/training
const addFaq = asyncHandler(async (req, res) => {
  const faq = clean(req.body);
  if (!faq.question || !faq.answer) {
    res.status(400);
    throw new Error("Add both a question and an answer.");
  }
  const current = await readFaqs(req.workspace._id);
  if (current.length >= MAX_FAQS) {
    res.status(400);
    throw new Error(`You can save up to ${MAX_FAQS} questions.`);
  }
  // Newest first — what they just wrote is what they want to see.
  await Workspace.updateOne(
    { _id: req.workspace._id },
    {
      $push: { "aiSettings.faqs": { $each: [faq], $position: 0 } },
      $set: { "aiSettings.faqsSeeded": true },
    },
  );
  res.status(201).json({ success: true, faqs: await readFaqs(req.workspace._id) });
});

// @PATCH /api/training/:id
const updateFaq = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404);
    throw new Error("That question wasn't found.");
  }
  const faq = clean(req.body);
  if (!faq.question || !faq.answer) {
    res.status(400);
    throw new Error("Add both a question and an answer.");
  }
  const result = await Workspace.updateOne(
    { _id: req.workspace._id, "aiSettings.faqs._id": req.params.id },
    {
      $set: {
        "aiSettings.faqs.$.question": faq.question,
        "aiSettings.faqs.$.answer": faq.answer,
      },
    },
  );
  if (!result.matchedCount) {
    res.status(404);
    throw new Error("That question wasn't found.");
  }
  res.json({ success: true, faqs: await readFaqs(req.workspace._id) });
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
  res.json({ success: true, faqs: await readFaqs(req.workspace._id) });
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
      },
    },
  );
  res.json({ success: true, faqs: await readFaqs(req.workspace._id) });
});

// @POST /api/training/test
// Body: { message, history?: [{role, content}] }
// The REAL reply logic, against the saved training. Nothing is sent to anyone
// and nothing is stored.
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
    // "faq" means it answered with one of their trained answers word for word.
    fromTraining: result?.provider === "faq",
    escalate: !!result?.escalate,
  });
});

module.exports = {
  listFaqs,
  addFaq,
  updateFaq,
  deleteFaq,
  resetFaqs,
  testAi,
};
