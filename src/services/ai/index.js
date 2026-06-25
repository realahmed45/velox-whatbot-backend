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

const STOP = new Set([
  "the", "a", "an", "is", "are", "do", "you", "your", "i", "to", "of", "and",
  "for", "in", "on", "it", "this", "that", "can", "how", "what", "when",
  "where", "me", "my", "we", "with", "have", "has",
]);
const tokenize = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Find an FAQ that clearly matches the user's message so we can answer
 * instantly and verbatim — no LLM call, no tokens, perfectly on-message.
 */
const matchFaq = (faqs, message) => {
  if (!Array.isArray(faqs) || !faqs.length) return null;
  const msgNorm = String(message || "").toLowerCase().trim();
  if (msgNorm.length < 2) return null;
  const msgTokens = new Set(tokenize(message));
  let best = null;
  let bestScore = 0;
  for (const f of faqs) {
    if (!f?.question || !f?.answer) continue;
    const qNorm = f.question.toLowerCase().trim();
    if (qNorm.length >= 6 && msgNorm.includes(qNorm)) return f; // contains question
    const qTokens = tokenize(f.question);
    if (!qTokens.length) continue;
    const overlap = qTokens.filter((t) => msgTokens.has(t)).length;
    const score = overlap / qTokens.length;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return bestScore >= 0.7 ? best : null;
};

/**
 * Build the system prompt from workspace.aiSettings (or legacy aiBot).
 */
const buildSystemPrompt = (workspace, contact, extraContext) => {
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

  // User-provided business knowledge: free-form notes + imported sources
  // (website, product list, etc.). Bounded so we don't blow the context window.
  const knowledge = workspace.aiKnowledge;
  if (knowledge?.enabled) {
    const blocks = [];
    if (knowledge.content?.trim()) blocks.push(knowledge.content.trim());
    (knowledge.sources || [])
      .filter((s) => s && s.status === "ready" && s.content?.trim())
      .forEach((s) => {
        const head = s.label || s.url || s.type;
        blocks.push(`[${head}]\n${s.content.trim()}`);
      });
    if (blocks.length) {
      const merged = blocks.join("\n\n").slice(0, 24000);
      lines.push(
        "",
        "Business knowledge (use these facts when answering questions; do NOT invent details outside this):",
        merged,
      );
    }
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

  // ── Goals & smart behaviour (value options the creator picks) ──
  const GOAL_TEXT = {
    support: "Answer questions accurately and helpfully.",
    sales:
      "Recommend the most relevant products and gently guide the person toward a purchase.",
    leads:
      "Spot genuine interest and turn the person into a lead. Be helpful first, then move things forward.",
    bookings:
      "Help the person book or schedule, and collect the details needed to confirm.",
    traffic:
      "When relevant, point the person to the right link instead of long explanations.",
  };
  const goals = Array.isArray(v2.goals) && v2.goals.length ? v2.goals : ["support"];
  const goalLines = goals.map((g) => GOAL_TEXT[g]).filter(Boolean);
  if (goalLines.length) {
    lines.push("", "Your goals on every reply:");
    goalLines.forEach((g) => lines.push(`- ${g}`));
  }
  if (v2.leadCapture) {
    lines.push(
      "When someone shows real interest, naturally ask for their name and best contact (email or phone) so the team can follow up. Ask once, don't nag.",
    );
  }
  if (v2.matchLanguage) {
    lines.push("Always reply in the same language the person wrote to you in.");
  }
  if (v2.engageBack) {
    lines.push(
      "End most replies with a short, friendly question or next step to keep the conversation going.",
    );
  }
  if (v2.ctaLink && String(v2.ctaLink).trim()) {
    lines.push(
      `When it helps, you may share this link: ${String(v2.ctaLink).trim()}`,
    );
  }

  // Live integration data (Shopify order status / products) for THIS message.
  if (extraContext && String(extraContext).trim()) {
    lines.push(
      "",
      "─── LIVE STORE DATA (highest priority for this reply) ───",
      String(extraContext).trim(),
      "─── END LIVE STORE DATA ───",
    );
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
  extraContext = null,
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

  // 1b. Instant FAQ answer — reply verbatim when a saved question clearly
  //     matches. Skipped when we have live store data to weave in.
  if (!escalate && !extraContext) {
    const faqHit = matchFaq(ai.faqs, userMessage);
    if (faqHit) {
      return {
        reply: faqHit.answer,
        escalate: false,
        tokens: 0,
        provider: "faq",
      };
    }
  }

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

  const systemPrompt = buildSystemPrompt(workspace, contact, extraContext);

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

/**
 * Return the first available chat client (Groq preferred, OpenAI fallback).
 */
const getAnyClient = () => {
  let client = getGroqClient();
  if (client) return { client, model: "llama-3.3-70b-versatile", provider: "groq" };
  client = getOpenaiClient();
  if (client) return { client, model: "gpt-4o-mini", provider: "openai" };
  return { client: null, model: null, provider: "none" };
};

/**
 * Low-level one-shot completion used by tools like the website importer.
 * Returns the text content, or null if no AI provider is configured / it fails.
 */
const complete = async ({
  system,
  user,
  maxTokens = 700,
  temperature = 0.3,
}) => {
  const { client, model } = getAnyClient();
  if (!client) return null;
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    });
    return r.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.error("AI complete() failed", { err: err.message });
    return null;
  }
};

/**
 * Vision completion — extract/describe content from an image.
 * Uses a Groq vision model (Llama 4 Scout) so it stays free + key-compatible.
 * @param {Buffer} buffer  raw image bytes
 * @param {string} mimetype  e.g. "image/png"
 * @param {string} instruction  what to do with the image
 * @returns {Promise<string|null>}
 */
const completeVision = async ({
  buffer,
  mimetype = "image/png",
  instruction,
  maxTokens = 1500,
}) => {
  const groq = getGroqClient();
  const oai = getOpenaiClient();
  const client = groq || oai;
  if (!client) return null;
  // Groq + OpenAI both accept base64 data URLs on a vision-capable model.
  const model = groq
    ? "meta-llama/llama-4-scout-17b-16e-instruct"
    : "gpt-4o-mini";
  const dataUrl = `data:${mimetype};base64,${buffer.toString("base64")}`;
  try {
    const r = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    });
    return r.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.error("AI completeVision() failed", { err: err.message });
    return null;
  }
};

module.exports = {
  generateReply,
  buildSystemPrompt,
  getAnyClient,
  complete,
  completeVision,
};
