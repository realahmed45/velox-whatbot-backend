/**
 * verticalController — business-category detection + one-shot workspace setup.
 *
 * Flow:
 *   GET  /verticals                       → picker list (client-safe packs)
 *   POST /:workspaceId/vertical/detect    → AI guesses the category
 *   POST /:workspaceId/vertical/apply     → seed persona/messages/FAQs/features
 *                                            + install the matching flow pack
 */
const asyncHandler = require("express-async-handler");
const Flow = require("../models/Flow");
const { pickerList, getPack } = require("../config/verticalPacks");
const { detectVertical, applyVertical } = require("../services/verticalService");
const { FLOW_TEMPLATES } = require("../utils/flowTemplates");
const logger = require("../utils/logger");

// @GET /api/verticals — the category grid for onboarding (no auth needed).
const listVerticals = asyncHandler(async (_req, res) => {
  res.json({ success: true, verticals: pickerList() });
});

// @POST /api/workspaces/:workspaceId/vertical/detect
// Reads the workspace's website brief + IG profile and guesses the category.
const detect = asyncHandler(async (req, res) => {
  const result = await detectVertical(req.workspace);
  logger.info(
    `[vertical] detect ws=${req.workspace._id} → ${result.category} (${result.confidence}%, ${result.source})`,
  );
  res.json({ success: true, ...result });
});

// @POST /api/workspaces/:workspaceId/vertical/apply
// Body: { category, force? }. Applies the pack, installs its flow template,
// and returns the fully-configured workspace summary.
const apply = asyncHandler(async (req, res) => {
  const { category, force } = req.body || {};
  if (!category) {
    res.status(400);
    throw new Error("Please choose a business category.");
  }

  const ws = await applyVertical(req.workspace, category, { force: !!force });

  // Install the matching flow-template pack — but only once, and only if the
  // user has no flows yet, so re-applying doesn't spawn duplicates.
  let flowsInstalled = 0;
  try {
    const pack = getPack(ws.industry);
    const tmplKey = pack.flowTemplateKey;
    const existing = await Flow.countDocuments({ workspaceId: ws._id });
    if (tmplKey && existing === 0) {
      const template = FLOW_TEMPLATES.find((t) => t.key === tmplKey);
      if (template) {
        for (const flowDef of template.flows) {
          await Flow.create({
            workspaceId: ws._id,
            name: flowDef.name,
            description: flowDef.description,
            nodes: flowDef.nodes,
            edges: flowDef.edges,
            template: tmplKey,
            status: "active",
            priority: flowDef.priority || 0,
            createdBy: req.user._id,
          });
          flowsInstalled++;
        }
      }
    }
  } catch (e) {
    // Never fail the whole apply just because flow seeding hiccuped.
    logger.warn("[vertical] flow template install failed", { err: e.message });
  }

  res.json({
    success: true,
    workspace: {
      industry: ws.industry,
      verticalConfigured: ws.verticalConfigured,
      features: ws.features,
      appointments: { enabled: !!ws.appointments?.enabled },
      goals: ws.aiSettings?.goals || [],
    },
    flowsInstalled,
  });
});

module.exports = { listVerticals, detect, apply };
