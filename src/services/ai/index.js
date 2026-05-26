/**
 * Botlify — Unified AI provider abstraction.
 *
 * Default: Groq (free, fast) → Llama 3.3 70B
 * Fallbacks: OpenAI (gpt-4o-mini) if configured, otherwise canned reply.
 *
 * Workspaces can override via workspace.aiSettings.provider.
 */
const logger = require("../../utils/logger");

let groqClient = null;
let openaiClient = null;

const getGroqClient = () => {
  if (groqClient) return groqClient;
  if (!process.env.GROQ_API_KEY) return null;
  try {
    // Groq uses the OpenAI SDK (drop-in compatible)
    const OpenAI = require("openai");
    groqClient = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    });
    return groqClient;
  } catch {
    logger.warn("OpenAI SDK not installed (used by Groq client)");
    return null;
  }
};

const getOpenaiClient = () => {
  if (openaiClient) return openaiClient;
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const OpenAI = require("openai");
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openaiClient;
  } catch {
    return null;
  }
};

const fallbackReply = (contact) => {
  const first = contact?.name?.split?.(" ")?.[0] || "there";
  return `Hey ${first}! Thanks for your message — a teammate will get back to you very soon. 💙`;
};

const pickAiCfg = (workspace) => workspace.aiSettings || workspace.aiBot || {};

/**
 * Build the system prompt from workspace.aiSettings (or legacy aiBot).
 */
const buildSystemPrompt = (workspace, contact) => {
  const v2 = pickAiCfg(workspace);
  const legacy = workspace.aiBot || {};
  const ai = {
    systemPrompt: v2.systemPrompt || legacy.personality,
    businessContext: v2.businessContext || legacy.businessInfo,
    faqs: v2.faqs && v2.faqs.length ? v2.faqs : legacy.faqs,
  };
  const channelEffective = "instagram";
  const lines = [
    ai.systemPrompt ||
      "You are a friendly, professional assistant. Keep replies short, warm, and helpful.",
  ];

  if (ai.businessContext) {
    lines.push("", "Business context:", ai.businessContext);
  }

  // User-provided business knowledge (Settings → AI Knowledge tab)
  const knowledge = workspace.aiKnowledge;
  if (knowledge?.enabled && knowledge?.content?.trim()) {
    lines.push(
      "",
      "Business knowledge (use these facts when answering questions; do NOT invent details outside this):",
      knowledge.content.trim(),
    );
  }

  // Smart Orders — turn the AI into a sales closer when enabled
  const smartOrders = workspace.smartOrders;
  if (smartOrders?.enabled && smartOrders?.catalog?.trim()) {
    lines.push(
      "",
      "─── SMART ORDERS MODE ───",
      "You are also a sales assistant. Below is the product catalog for this business. Use these EXACT prices and product names. Never invent items or prices that aren't listed.",
      "",
      "PRODUCT CATALOG:",
      smartOrders.catalog.trim(),
    );
    if (smartOrders.paymentInstructions?.trim()) {
      lines.push(
        "",
        "PAYMENT INSTRUCTIONS:",
        smartOrders.paymentInstructions.trim(),
      );
    }
    lines.push(
      "",
      "When a customer wants to place an order, your job is to politely collect:",
      "  1. The product(s) they want, including quantity and any variant (size, color)",
      "  2. Their full name",
      "  3. Complete delivery address",
      "  4. A contact phone number",
      "  5. Preferred payment method (from the instructions above)",
      "",
      "Ask for missing fields one or two at a time — don't dump a long form. Confirm prices and totals as you go. Be conversational, not robotic.",
      "",
      "When ALL of the following are collected — items, customer name, full delivery address — you MUST end your reply with a hidden order block on its own line, in this exact format:",
      '<<ORDER_JSON>>{"items":[{"name":"<product>","qty":<int>,"variant":"<size/color or empty>","price":<unit price number>}],"customerName":"<full name>","customerAddress":"<full address>","customerPhone":"<phone or empty>","paymentMethod":"<method>","subtotal":<total number>,"currency":"<PKR/USD/etc>","notes":"<any extra notes from the customer>"}<<END_ORDER>>',
      "",
      "The order block is parsed by the system — it is NEVER shown to the customer. Above the block, write a friendly confirmation message summarising the order and totals. Only emit the block once, when you have everything. If something is still missing, do NOT emit the block — just keep collecting.",
      "─── END SMART ORDERS ───",
    );
  }

  if (Array.isArray(ai.faqs) && ai.faqs.length) {
    lines.push("", "Known FAQs (use these if the user asks):");
    ai.faqs
      .filter((f) => f && f.question && f.answer)
      .slice(0, 30)
      .forEach((f, i) => {
        lines.push(`${i + 1}. Q: ${f.question}\n   A: ${f.answer}`);
      });
  }

  const handle =
    contact?.igUsername || contact?.username || contact?.phone || "user";
  lines.push("", `The customer's identifier is: ${handle}.`);
  lines.push("You are replying via Instagram DM.");
  lines.push(
    "Keep replies 1-3 sentences, natural, and warm. Never invent prices, links, addresses, or policies that you weren't told.",
  );
  lines.push(
    "If the user clearly wants a human, escalate by responding with: ESCALATE: <short reason>.",
  );
  lines.push("Never pretend to be human. Never fabricate facts.");

  return lines.join("\n");
};

/**
 * Generate a chatbot reply.
 *
 * @param {Object} opts
 * @param {Object} opts.workspace
 * @param {Array}  opts.history     [{role:'user'|'assistant', content:'...'}]
 * @param {string} opts.userMessage
 * @param {Object} opts.contact
 * @returns {Promise<{reply:string, escalate:boolean, tokens:number, provider:string}>}
 */
const generateReply = async ({
  workspace,
  history = [],
  userMessage,
  contact,
}) => {
  const ai = {
    ...(workspace.aiBot || {}),
    ...pickAiCfg(workspace),
  };
  // Map legacy field names
  if (!ai.handoffKeywords && workspace.aiBot?.escalateOnKeywords)
    ai.handoffKeywords = workspace.aiBot.escalateOnKeywords;

  // 1. Early escalation by keyword
  const escalateKw = ai.handoffKeywords || ["human", "agent", "support"];
  const lower = (userMessage || "").toLowerCase();
  let escalate = escalateKw.some((kw) =>
    lower.includes(String(kw).toLowerCase()),
  );

  // 2. Determine provider
  const requested = (ai.provider || "groq").toLowerCase();
  let client = null;
  let model = null;
  let providerUsed = null;

  if (requested === "groq" || requested === "auto") {
    client = getGroqClient();
    let requestedModel = ai.model || "llama-3.3-70b-versatile";
    // Remap decommissioned Groq models to current equivalents
    const GROQ_DEPRECATED = {
      "llama-3.1-70b-versatile": "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant": "llama-3.1-8b-instant", // still active, keep
      "mixtral-8x7b-32768": "llama-3.3-70b-versatile",
    };
    model = GROQ_DEPRECATED[requestedModel] ?? requestedModel;
    providerUsed = "groq";
  }

  if (!client && (requested === "openai" || requested === "auto")) {
    client = getOpenaiClient();
    model = ai.model || "gpt-4o-mini";
    providerUsed = "openai";
  }

  // Auto fallback chain — try the other provider if primary missing
  if (!client) {
    client = getGroqClient();
    if (client) {
      model = "llama-3.1-70b-versatile";
      providerUsed = "groq";
    }
  }
  if (!client) {
    client = getOpenaiClient();
    if (client) {
      model = "gpt-4o-mini";
      providerUsed = "openai";
    }
  }

  if (!client) {
    return {
      reply: fallbackReply(contact),
      escalate: true,
      tokens: 0,
      provider: "none",
    };
  }

  const systemPrompt = buildSystemPrompt(workspace, contact);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-10),
        { role: "user", content: userMessage || "" },
      ],
      temperature: typeof ai.temperature === "number" ? ai.temperature : 0.4,
      max_tokens: ai.maxTokens || 240,
    });

    let reply =
      response.choices?.[0]?.message?.content?.trim() ||
      "Thanks for your message! A teammate will reply shortly.";

    // Detect ESCALATE: prefix
    if (/^\s*ESCALATE\s*:/i.test(reply)) {
      escalate = true;
      reply =
        reply.replace(/^\s*ESCALATE\s*:\s*/i, "").trim() ||
        fallbackReply(contact);
    }

    return {
      reply,
      escalate,
      tokens: response.usage?.total_tokens || 0,
      provider: providerUsed,
    };
  } catch (err) {
    logger.error(`AI generateReply (${providerUsed}) failed`, {
      err: err.message,
    });
    return {
      reply: fallbackReply(contact),
      escalate: true,
      tokens: 0,
      provider: providerUsed,
    };
  }
};

module.exports = {
  generateReply,
  buildSystemPrompt,
};
