/**
 * verticalService.js — detects a workspace's business category and applies the
 * matching vertical pack (config/verticalPacks.js) across the whole workspace:
 * persona, goal, messages, FAQs, features, and appointment defaults.
 *
 * Kept separate from the controller so the same logic can be reused (e.g. from
 * onboarding, a settings change, or a future re-detect job).
 */
const ai = require("./ai");
const logger = require("../utils/logger");
const {
  PACKS,
  VERTICAL_KEYS,
  getPack,
} = require("../config/verticalPacks");

/**
 * Guess the vertical for a workspace from whatever business signal we have:
 * the imported website/knowledge brief + the Instagram bio/name.
 *
 * Strategy: (1) ask the AI to classify into one of our keys; (2) fall back to a
 * keyword-hint heuristic; (3) default to `general`. Always returns a valid key.
 *
 * @returns {Promise<{ category: string, confidence: number, reasoning: string, source: string }>}
 */
async function detectVertical(workspace) {
  const igName =
    workspace.instagram?.displayName || workspace.instagram?.username || "";
  const bio = workspace.instagram?.bio || "";
  const brief =
    (workspace.aiKnowledge?.content || "").trim() ||
    (workspace.aiSettings?.businessContext || "").trim() ||
    "";
  const sourceText = [igName, bio, brief].filter(Boolean).join("\n").slice(0, 6000);

  // Nothing to go on — don't guess, let the user pick.
  if (!sourceText.trim()) {
    return {
      category: "general",
      confidence: 0,
      reasoning: "No website or profile info yet — please pick your business type.",
      source: "empty",
    };
  }

  // Build the option list for the classifier from the registry.
  const options = VERTICAL_KEYS.map(
    (k) => `- ${k}: ${PACKS[k].label} (${PACKS[k].tagline})`,
  ).join("\n");

  const system =
    "You classify a business into exactly ONE category key from the list. " +
    "Output ONLY a compact JSON object: { category, confidence, reasoning }. " +
    "No markdown, no code fences.\n" +
    "- category: MUST be one of the exact keys below.\n" +
    "- confidence: 0-100 how sure you are.\n" +
    "- reasoning: one short sentence citing the clue that decided it.\n" +
    "If genuinely unclear, use 'general' with a low confidence.\n\n" +
    "CATEGORY KEYS:\n" +
    options;

  let aiResult = null;
  try {
    const raw = await ai.complete({
      system,
      user: `Business info:\n${sourceText}`,
      temperature: 0.1,
      maxTokens: 200,
    });
    if (raw && raw.includes("{")) {
      const jsonStr = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      const p = JSON.parse(jsonStr);
      if (p && VERTICAL_KEYS.includes(p.category)) {
        aiResult = {
          category: p.category,
          confidence: Math.max(0, Math.min(100, Number(p.confidence) || 60)),
          reasoning: String(p.reasoning || "").slice(0, 200),
          source: "ai",
        };
      }
    }
  } catch (e) {
    logger.warn("[verticalService] AI detect failed", { err: e.message });
  }
  if (aiResult) return aiResult;

  // Heuristic fallback — score each pack by keyword-hint hits.
  const hay = sourceText.toLowerCase();
  let best = { key: "general", hits: 0 };
  for (const key of VERTICAL_KEYS) {
    const hits = (PACKS[key].detectionHints || []).filter((h) =>
      hay.includes(h),
    ).length;
    if (hits > best.hits) best = { key, hits };
  }
  return {
    category: best.key,
    confidence: best.hits ? Math.min(70, 40 + best.hits * 10) : 20,
    reasoning: best.hits
      ? `Matched keywords for ${PACKS[best.key].label}.`
      : "Couldn't detect confidently — please confirm your business type.",
    source: best.hits ? "heuristic" : "default",
  };
}

/**
 * Apply a confirmed vertical to the workspace document (mutates + saves).
 * Seeds only fields the user hasn't already customised, so re-applying or
 * changing category never clobbers hand-edited copy unless `force` is set.
 *
 * @param {object}  workspace  the workspace doc (will be saved)
 * @param {string}  category   a valid vertical key
 * @param {object}  [opts]
 * @param {boolean} [opts.force] overwrite existing persona/messages even if set
 * @returns {Promise<object>} the saved workspace
 */
async function applyVertical(workspace, category, opts = {}) {
  const key = VERTICAL_KEYS.includes(category) ? category : "general";
  const pack = getPack(key);
  const force = !!opts.force;

  // Only fill a field if it's empty (or force). Keeps user edits safe.
  const fill = (current, next) =>
    force || !current || !String(current).trim() ? next : current;

  workspace.industry = key;

  // ── Features ──────────────────────────────────────────────────────────
  workspace.features = { ...(pack.features || {}) };

  // ── AI settings: persona + goal + leadCapture ─────────────────────────
  workspace.aiSettings = workspace.aiSettings || {};
  const p = pack.persona || {};
  workspace.aiSettings.aiRole = fill(workspace.aiSettings.aiRole, p.aiRole);
  workspace.aiSettings.brandVoice = fill(
    workspace.aiSettings.brandVoice,
    p.brandVoice,
  );
  workspace.aiSettings.guardrails = fill(
    workspace.aiSettings.guardrails,
    p.guardrails,
  );
  workspace.aiSettings.goals = [pack.goal || "support"];
  if (pack.features?.leadCapture) workspace.aiSettings.leadCapture = true;

  // Seed FAQ starter pack only if the user has none yet (never duplicate).
  if (
    Array.isArray(pack.faqStarters) &&
    pack.faqStarters.length &&
    (!Array.isArray(workspace.aiSettings.faqs) ||
      workspace.aiSettings.faqs.length === 0)
  ) {
    workspace.aiSettings.faqs = pack.faqStarters.map((f) => ({
      question: f.question,
      answer: f.answer,
    }));
  }

  // ── DM automation messages (welcome / fallback / away) ────────────────
  const m = pack.messages || {};
  if (m.welcome) {
    workspace.dmMessages = workspace.dmMessages || {};
    workspace.dmMessages.greeting = fill(
      workspace.dmMessages.greeting,
      m.welcome,
    );
  }
  if (m.fallback) {
    workspace.fallbackReply = workspace.fallbackReply || {};
    workspace.fallbackReply.message = fill(
      workspace.fallbackReply.message,
      m.fallback,
    );
  }
  if (m.away) {
    workspace.awayReply = workspace.awayReply || {};
    workspace.awayReply.message = fill(workspace.awayReply.message, m.away);
  }

  // ── Smart Orders for selling verticals ────────────────────────────────
  if (pack.features?.orders) {
    workspace.smartOrders = workspace.smartOrders || {};
    workspace.smartOrders.enabled = true;
  }

  // ── Appointment scheduling for booking verticals ──────────────────────
  if (pack.features?.appointments) {
    const sd = pack.slotDefaults || {};
    const appts = workspace.appointments || {};
    workspace.appointments = {
      ...appts,
      enabled: true,
      slotMinutes: appts.slotMinutes || sd.slotMinutes || 30,
      bufferMinutes:
        appts.bufferMinutes != null ? appts.bufferMinutes : sd.bufferMinutes ?? 10,
      capacityPerSlot: appts.capacityPerSlot || 1,
      advanceDays: appts.advanceDays || 30,
      minNoticeHours: appts.minNoticeHours != null ? appts.minNoticeHours : 2,
      requireApproval:
        appts.requireApproval != null
          ? appts.requireApproval
          : !!pack.requireApprovalByDefault,
      services:
        Array.isArray(appts.services) && appts.services.length
          ? appts.services
          : (sd.services || []).map((s) => ({ ...s })),
    };
    // Seed sensible business hours if none set yet (needed for slot math).
    if (
      (!Array.isArray(workspace.businessHours) ||
        workspace.businessHours.length === 0) &&
      Array.isArray(sd.hours)
    ) {
      workspace.businessHours = sd.hours.map((h) => ({ ...h }));
    }
  }

  workspace.verticalConfigured = true;
  await workspace.save();

  logger.info(
    `[verticalService] applied vertical=${key} ws=${workspace._id} features=${JSON.stringify(workspace.features)}`,
  );
  return workspace;
}

module.exports = { detectVertical, applyVertical };
