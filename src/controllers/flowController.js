const asyncHandler = require("express-async-handler");
const Flow = require("../models/Flow");
const { FLOW_TEMPLATES } = require("../utils/flowTemplates");

/**
 * Validate flow structure before activation
 * @param {Array} nodes - Flow nodes
 * @param {Array} edges - Flow edges
 * @returns {Object} { valid: boolean, errors: string[] }
 */
const validateFlow = (nodes, edges) => {
  const errors = [];

  if (!nodes || nodes.length === 0) {
    errors.push("Flow must have at least one node");
    return { valid: false, errors };
  }

  // Check for trigger node
  const triggers = nodes.filter((n) => n.type === "trigger");
  if (!triggers.length) {
    errors.push("Flow must have a trigger node");
  }

  // A keyword trigger with no keywords can never fire — catch it here rather
  // than letting the user activate a flow that silently does nothing.
  triggers.forEach((t) => {
    const nt = t.nodeType;
    if (nt === "keyword_trigger" || nt === "keyword_match" || nt === "keyword_dm") {
      const kws = (t.data?.keywords || []).filter(
        (k) => String(k || "").trim() !== "",
      );
      if (!kws.length) {
        errors.push(
          "Your keyword trigger has no keywords — add at least one word that should start this flow",
        );
      }
    }
  });

  // Every trigger needs something wired after it, or the flow does nothing.
  triggers.forEach((t) => {
    const hasOutgoing = edges?.some((e) => e.source === t.id);
    if (!hasOutgoing) {
      errors.push(
        "Your trigger isn't connected to anything — drag a line from it to your first step",
      );
    }
  });

  // Build adjacency map for validation
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeMap = new Map();

  edges?.forEach((edge) => {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge references non-existent source node: ${edge.source}`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge references non-existent target node: ${edge.target}`);
    }

    if (!edgeMap.has(edge.source)) {
      edgeMap.set(edge.source, []);
    }
    edgeMap.get(edge.source).push(edge.target);
  });

  // Orphaned nodes. A node with NO edges at all is just an unfinished step the
  // user hasn't wired yet — that shouldn't block activation (the engine simply
  // never reaches it). What we do flag is a node that feeds others but has no
  // way in, since that's a genuinely unreachable branch.
  nodes.forEach((node) => {
    if (node.type === "trigger") return;
    const hasIncoming = edges?.some((e) => e.target === node.id);
    const hasOutgoing = edges?.some((e) => e.source === node.id);
    if (!hasIncoming && hasOutgoing) {
      errors.push(
        `"${node.data?.label || node.id}" can never be reached — connect a step into it (or delete it)`,
      );
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
};

// @GET /api/flows — List all flows for workspace
const getFlows = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = { workspaceId: req.workspace._id };
  if (status) filter.status = status;

  const flows = await Flow.find(filter).sort({ priority: -1, updatedAt: -1 });
  res.json({ success: true, flows });
});

// @GET /api/flows/:id — Get single flow
const getFlow = asyncHandler(async (req, res) => {
  const flow = await Flow.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!flow) {
    res.status(404);
    throw new Error("Flow not found");
  }
  res.json({ success: true, flow });
});

// @POST /api/flows — Create new flow
const createFlow = asyncHandler(async (req, res) => {
  const { name, description, nodes, edges, template, priority } = req.body;
  if (!name) {
    res.status(400);
    throw new Error("Flow name is required");
  }

  // Check flow limit for Starter plan
  const limits = req.workspace.getPlanLimits();
  if (limits.flows !== Infinity) {
    const count = await Flow.countDocuments({
      workspaceId: req.workspace._id,
      status: { $ne: "archived" },
    });
    if (count >= limits.flows) {
      res.status(403);
      throw new Error(
        `Your plan allows a maximum of ${limits.flows} flows. Upgrade to create more.`,
      );
    }
  }

  const flow = await Flow.create({
    workspaceId: req.workspace._id,
    name,
    description,
    nodes: nodes || [],
    edges: edges || [],
    template: template || null,
    priority: priority || 0,
    createdBy: req.user._id,
  });

  res.status(201).json({ success: true, flow });
});

// @PUT /api/flows/:id — Update flow
const updateFlow = asyncHandler(async (req, res) => {
  const flow = await Flow.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!flow) {
    res.status(404);
    throw new Error("Flow not found");
  }

  const { name, description, nodes, edges, status, priority } = req.body;

  if (name !== undefined) flow.name = name;
  if (description !== undefined) flow.description = description;
  if (nodes !== undefined) {
    if (nodes.length > 50) {
      res.status(400);
      throw new Error("Maximum 50 nodes per flow");
    }
    flow.nodes = nodes;
  }
  if (edges !== undefined) flow.edges = edges;
  if (priority !== undefined) flow.priority = priority;

  // Validate flow before activating
  if (status === "active" && status !== flow.status) {
    const validation = validateFlow(nodes || flow.nodes, edges || flow.edges);
    if (!validation.valid) {
      res.status(400);
      throw new Error(
        `Flow validation failed: ${validation.errors.join(", ")}`,
      );
    }
    flow.publishedAt = new Date();
  }

  if (status !== undefined) {
    flow.status = status;
    flow.version += 1;
  }

  await flow.save();
  res.json({ success: true, flow });
});

// @DELETE /api/flows/:id — Archive flow
const deleteFlow = asyncHandler(async (req, res) => {
  const flow = await Flow.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!flow) {
    res.status(404);
    throw new Error("Flow not found");
  }

  flow.status = "archived";
  await flow.save();

  res.json({ success: true, message: "Flow archived" });
});

// @POST /api/flows/:id/duplicate — Clone a flow
const duplicateFlow = asyncHandler(async (req, res) => {
  const original = await Flow.findOne({
    _id: req.params.id,
    workspaceId: req.workspace._id,
  });
  if (!original) {
    res.status(404);
    throw new Error("Flow not found");
  }

  const duplicate = await Flow.create({
    workspaceId: req.workspace._id,
    name: `${original.name} (Copy)`,
    description: original.description,
    nodes: original.nodes,
    edges: original.edges,
    template: original.template,
    priority: original.priority,
    status: "draft",
    createdBy: req.user._id,
  });

  res.status(201).json({ success: true, flow: duplicate });
});

// @GET /api/flows/templates — Get industry templates
const getTemplates = asyncHandler(async (req, res) => {
  res.json({ success: true, templates: FLOW_TEMPLATES });
});

// @POST /api/flows/from-template — Create flows from template
const createFromTemplate = asyncHandler(async (req, res) => {
  const { templateKey } = req.body;
  const template = FLOW_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) {
    res.status(404);
    throw new Error("Template not found");
  }

  const createdFlows = [];
  for (const flowDef of template.flows) {
    const flow = await Flow.create({
      workspaceId: req.workspace._id,
      name: flowDef.name,
      description: flowDef.description,
      nodes: flowDef.nodes,
      edges: flowDef.edges,
      template: templateKey,
      status: "active",
      priority: flowDef.priority || 0,
      createdBy: req.user._id,
    });
    createdFlows.push(flow);
  }

  res
    .status(201)
    .json({ success: true, flows: createdFlows, count: createdFlows.length });
});

// @PATCH /api/flows/:id/priority — Update flow priority (for ordering)
const updatePriority = asyncHandler(async (req, res) => {
  const { priority } = req.body;
  const flow = await Flow.findOneAndUpdate(
    { _id: req.params.id, workspaceId: req.workspace._id },
    { priority },
    { new: true },
  );
  if (!flow) {
    res.status(404);
    throw new Error("Flow not found");
  }
  res.json({ success: true, flow });
});

module.exports = {
  getFlows,
  getFlow,
  createFlow,
  updateFlow,
  deleteFlow,
  duplicateFlow,
  getTemplates,
  createFromTemplate,
  updatePriority,
};
