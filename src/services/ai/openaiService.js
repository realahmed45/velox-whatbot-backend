/**
 * Botlify — OpenAI Conversational Bot (Scale / Premium plan)
 * Generates contextual replies using chat history + workspace personality.
 */
const logger = require("../../utils/logger");

let openaiClient = null;
const getClient = () => {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const OpenAI = require("openai");
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openaiClient;
  } catch (e) {
    logger.warn("OpenAI SDK not installed: run `npm install openai`");
    return null;
  }
};

/**
 * Generate an AI reply for a conversation.
 * @param {Object} opts
 * @param {Object} opts.workspace   — workspace doc with aiBot config
 * @param {Array}  opts.history     — [{role:'user'|'assistant', content:'...'}]
 * @param {string} opts.userMessage — the latest inbound message
 * @param {Object} opts.contact     — contact doc (for name personalization)
 * @returns {Promise<{reply:string, escalate:boolean, tokens:number}>}
 */
const generateReply = async ({
  workspace,
  history = [],
  userMessage,
  contact,
}) => {
  const client = getClient();
  const cfg = workspace.aiBot || {};
  const personality =
    cfg.personality ||
    "You are a friendly, professional assistant for our Instagram business.";
  const businessInfo = cfg.businessInfo || "";
  const model = cfg.model || "gpt-4o-mini";
  const escalateKeywords = cfg.escalateOnKeywords || [
    "human",
    "agent",
    "support",
  ];

  // Early escalation check
  const lower = (userMessage || "").toLowerCase();
  const needsEscalation = escalateKeywords.some((kw) =>
    lower.includes(kw.toLowerCase()),
  );

  if (!client) {
    // Graceful fallback when no API key
    return {
      reply: `Hey ${contact?.name?.split(" ")[0] || "there"}! Thanks for your message — we'll get back to you shortly. 💙`,
      escalate: needsEscalation,
      tokens: 0,
    };
  }

  const systemPrompt = [
    personality,
    businessInfo ? `\nBusiness info:\n${businessInfo}` : "",
    `\nThe customer's Instagram handle is @${contact?.igUsername || contact?.username || "user"}.`,
    "Keep replies short (1-3 sentences), natural, and warm. Do not make up prices, links, or policies. If the user asks about things you don't know, suggest a human will reply soon.",
    "Never pretend to be human. Never promise things on behalf of the business unless the business info explicitly covers it.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-10),
        { role: "user", content: userMessage || "" },
      ],
      temperature: 0.7,
      max_tokens: 220,
    });

    const reply =
      response.choices?.[0]?.message?.content?.trim() ||
      "Thanks for your message! A teammate will reply shortly.";
    const tokens = response.usage?.total_tokens || 0;

    return { reply, escalate: needsEscalation, tokens };
  } catch (err) {
    logger.error("OpenAI generateReply failed", { err: err.message });
    return {
      reply: `Hey ${contact?.name?.split(" ")[0] || "there"}! Thanks for reaching out — a teammate will get back to you very soon. 💙`,
      escalate: true,
      tokens: 0,
    };
  }
};

module.exports = { generateReply };
