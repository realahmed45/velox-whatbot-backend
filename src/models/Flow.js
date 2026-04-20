const mongoose = require("mongoose");

const nodeDataSchema = new mongoose.Schema(
  {
    // For all nodes
    label: String,

    // Trigger nodes
    keywords: [String],
    matchType: {
      type: String,
      enum: ["exact", "contains", "starts_with", "ends_with"],
    },
    timeRange: { start: String, end: String },
    days: [String],
    minutesThreshold: Number,
    buttonId: String,

    // Action nodes
    message: String,
    imageUrl: String,
    fileUrl: String,
    fileName: String,
    questionText: String,
    variableName: String,
    questionTimeout: Number,
    buttons: [
      {
        id: String,
        label: String,
        nextNodeId: String,
      },
    ],
    listSections: [
      {
        title: String,
        rows: [
          {
            id: String,
            title: String,
            description: String,
          },
        ],
      },
    ],
    delaySeconds: Number,
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    tagName: String,

    // Condition
    conditionVariable: String,
    conditionOperator: {
      type: String,
      enum: ["contains", "equals", "starts_with", "ends_with", "not_contains"],
    },
    conditionValue: String,
  },
  { _id: false, strict: false },
);

const flowNodeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ["trigger", "action", "condition"],
      required: true,
    },
    nodeType: {
      type: String,
      enum: [
        // Triggers — Instagram
        "new_follower",
        "keyword_dm",
        "direct_message",
        "story_mention",
        "post_comment",
        "story_reply",
        // Triggers — generic
        "first_message",
        "keyword_match",
        "any_message",
        "time_condition",
        "no_reply",
        "button_click",
        // Actions
        "send_text",
        "send_image",
        "send_file",
        "ask_question",
        "button_menu",
        "list_menu",
        "delay",
        "assign_agent",
        "tag_contact",
        "end_flow",
        // Condition
        "condition",
      ],
      required: true,
    },
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    data: nodeDataSchema,
  },
  { _id: false },
);

const flowEdgeSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    target: { type: String, required: true },
    sourceHandle: String,
    targetHandle: String,
    label: String,
  },
  { _id: false },
);

const flowSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: String,
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "draft",
    },
    priority: { type: Number, default: 0 },
    nodes: [flowNodeSchema],
    edges: [flowEdgeSchema],
    template: {
      type: String,
      enum: [
        "restaurant",
        "beauty_salon",
        "retail",
        "real_estate",
        "general_faq",
        null,
      ],
      default: null,
    },

    // Stats
    stats: {
      totalTriggers: { type: Number, default: 0 },
      completions: { type: Number, default: 0 },
      lastTriggeredAt: Date,
    },

    // Versioning
    version: { type: Number, default: 1 },
    publishedAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
  },
);

flowSchema.index({ workspaceId: 1, status: 1, priority: -1 });

module.exports = mongoose.model("Flow", flowSchema);
