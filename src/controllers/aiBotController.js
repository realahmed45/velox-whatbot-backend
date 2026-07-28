/**
 * AI Bot controller — persona auto-draft (Phase 1) and the Playground
 * test sandbox (Phase 2). All workspace-scoped and owner/agent gated.
 */
const asyncHandler = require("express-async-handler");
const Workspace = require("../models/Workspace");
const ai = require("../services/ai");
const logger = require("../utils/logger");

// @POST /api/workspaces/:workspaceId/ai/draft-persona
// Auto-draft AI Role, Brand Voice and Guardrails from the connected Instagram
// profile + any business context the user already entered. Returns the three
// fields for the user to review and edit — it does NOT save them.
const draftPersona = asyncHandler(async (req, res) => {
  const ws = req.workspace;
  const igName =
    ws.instagram?.displayName || ws.instagram?.username || ws.name || "";
  const igHandle = ws.instagram?.username ? `@${ws.instagram.username}` : "";
  const context =
    (ws.aiSettings?.businessContext || "").trim() ||
    (ws.aiKnowledge?.content || "").trim() ||
    "";

  const system =
    "You write concise AI-assistant configuration for an Instagram DM bot. " +
    "Given a business, output ONLY a compact JSON object with three string fields: " +
    "aiRole, brandVoice, guardrails. No markdown, no code fences, no extra text.\n" +
    "- aiRole: 1-2 sentences describing who the assistant is and what business it represents (speak in 2nd person, e.g. 'You are the assistant for …').\n" +
    "- brandVoice: 3-5 short bullet-style tone/format rules on ONE line separated by '; ' (e.g. 'warm and friendly; concise 1-2 lines; at most 1 emoji; never pushy').\n" +
    "- guardrails: 3-5 short 'never do' rules on ONE line separated by '; ' (e.g. 'never quote a price you weren't given; never promise refunds; never share personal data; hand off angry customers to a human').";

  const user = `Business: ${igName} ${igHandle}\n${
    context ? `What they do / context:\n${context}` : "No extra context provided — infer sensible defaults for a small Instagram business."
  }`;

  const raw = await ai.complete({ system, user, temperature: 0.4, maxTokens: 500 });

  // Parse the JSON out of the model response defensively.
  let parsed = null;
  if (raw) {
    try {
      const jsonStr = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      logger.warn("[draftPersona] JSON parse failed", { raw: raw.slice(0, 200) });
    }
  }

  // Fallback so the endpoint never fails the UX.
  if (!parsed || typeof parsed !== "object") {
    parsed = {
      aiRole: `You are the friendly assistant for ${igName || "our Instagram page"}, helping followers over DM.`,
      brandVoice:
        "warm and human; concise 1-2 lines; at most 1 emoji; mirror the customer's language; never pushy",
      guardrails:
        "never quote a price you weren't given; never promise refunds or policies you don't know; never share personal data; hand off angry customers or complaints to a human",
    };
  }

  res.json({
    success: true,
    persona: {
      aiRole: String(parsed.aiRole || "").trim(),
      brandVoice: String(parsed.brandVoice || "").trim(),
      guardrails: String(parsed.guardrails || "").trim(),
    },
  });
});

// @POST /api/workspaces/:workspaceId/ai/playground
// Body: { message, history?: [{role, content}] }
// Runs the REAL bot logic against a test message and returns the reply — no
// Instagram message is sent, nothing is persisted. Lets the user try the bot
// before going live.
const playground = asyncHandler(async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message || !String(message).trim()) {
    res.status(400);
    throw new Error("A test message is required");
  }

  // Load the freshest workspace so unsaved-then-saved config is reflected.
  const ws = await Workspace.findById(req.workspace._id);

  const cleanHistory = Array.isArray(history)
    ? history
        .filter((m) => m && m.role && m.content)
        .slice(-12)
        .map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content),
        }))
    : [];

  const result = await ai.generateReply({
    workspace: ws,
    history: cleanHistory,
    userMessage: String(message),
    contact: { name: "Test user", igUsername: "test_user" },
    channel: "instagram",
  });

  res.json({
    success: true,
    reply: result?.reply || "",
    escalate: !!result?.escalate,
    provider: result?.provider || "none",
    imageUrls: result?.imageUrls || [],
    intent: result?.intent || null,
    tags: result?.tags || [],
  });
});

module.exports = { draftPersona, playground };
