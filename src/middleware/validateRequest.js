/**
 * Botlify — Request Validation Middleware
 * Joi-based schema validation for API endpoints
 */
const Joi = require("joi");

/**
 * Validate request body against a Joi schema
 */
const validate = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      const fields = error.details.reduce((acc, detail) => {
        const field = detail.path.join(".");
        acc[field] = detail.message.replace(/"/g, "");
        return acc;
      }, {});

      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request data",
          fields,
        },
      });
    }

    // Replace req.body with validated & sanitized value
    req.validatedBody = value;
    next();
  };
};

/**
 * Common validation schemas
 */
const schemas = {
  // Flow creation/update
  flow: Joi.object({
    name: Joi.string().required().max(255).trim(),
    description: Joi.string().optional().max(1000).trim().allow(""),
    nodes: Joi.array().items(Joi.object()).optional(),
    edges: Joi.array().items(Joi.object()).optional(),
    status: Joi.string().valid("draft", "active", "paused").optional(),
    priority: Joi.number().optional(),
  }),

  // Broadcast campaign
  broadcast: Joi.object({
    name: Joi.string().required().max(255).trim(),
    message: Joi.string().required().max(1000).trim(),
    mediaUrl: Joi.string().uri().optional().allow(null, ""),
    targetTags: Joi.array().items(Joi.string()).optional(),
    scheduledAt: Joi.date().optional().allow(null),
  }),

  // Contact update
  contactUpdate: Joi.object({
    name: Joi.string().max(255).trim().optional(),
    email: Joi.string().email().optional().allow(null, ""),
    phone: Joi.string().max(50).optional().allow(null, ""),
    tags: Joi.array().items(Joi.string()).optional(),
    customFields: Joi.object().optional(),
    notes: Joi.string().max(2000).optional().allow(null, ""),
  }),

  // AI caption generation
  aiCaption: Joi.object({
    topic: Joi.string().required().min(3).max(500).trim(),
    tone: Joi.string()
      .valid("casual", "professional", "funny", "inspirational", "salesy")
      .optional(),
    count: Joi.number().min(1).max(5).optional(),
    language: Joi.string().valid("en", "ur", "ar", "es", "fr", "hi").optional(),
  }),

  // Webhook integration
  webhookIntegration: Joi.object({
    name: Joi.string().required().max(255).trim(),
    url: Joi.string().uri().required(),
    events: Joi.array().items(Joi.string()).optional(),
    enabled: Joi.boolean().optional(),
  }),
};

module.exports = {
  validate,
  schemas,
};
