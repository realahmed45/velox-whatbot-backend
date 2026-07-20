/**
 * Botlify — Unified AI provider abstraction.
 *
 * Default: OpenAI gpt-4o-mini (best quality/cost ratio)
 * Fallback: Groq (free, fast) if no OpenAI key configured
 */
const logger = require("../../utils/logger");

let groqClient = null;
let openaiClient = null;

const getGroqClient = () => {
  if (groqClient) return groqClient;
  if (!process.env.GROQ_API_KEY) return null;
  try {
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
  "the",
  "a",
  "an",
  "is",
  "are",
  "do",
  "you",
  "your",
  "i",
  "to",
  "of",
  "and",
  "for",
  "in",
  "on",
  "it",
  "this",
  "that",
  "can",
  "how",
  "what",
  "when",
  "where",
  "me",
  "my",
  "we",
  "with",
  "have",
  "has",
]);
const tokenize = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Find an FAQ that clearly matches the user's message.
 */
const matchFaq = (faqs, message) => {
  if (!Array.isArray(faqs) || !faqs.length) return null;
  const msgNorm = String(message || "")
    .toLowerCase()
    .trim();
  if (msgNorm.length < 2) return null;
  const msgTokens = new Set(tokenize(message));
  let best = null;
  let bestScore = 0;
  for (const f of faqs) {
    if (!f?.question || !f?.answer) continue;
    const qNorm = f.question.toLowerCase().trim();
    if (qNorm.length >= 6 && msgNorm.includes(qNorm)) return f;
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
 * Build the system prompt — tuned for GPT-4o mini's superior instruction-following.
 */
const buildSystemPrompt = (workspace, contact, extraContext) => {
  const v2 = pickAiCfg(workspace);
  const legacy = workspace.aiBot || {};
  const ai = {
    systemPrompt: v2.systemPrompt || legacy.personality,
    businessContext: v2.businessContext || legacy.businessInfo,
    faqs: v2.faqs && v2.faqs.length ? v2.faqs : legacy.faqs,
  };

  const lines = [
    ai.systemPrompt ||
      "You are a warm, on-brand Instagram assistant replying to DMs, comments and story replies for this business. Sound like a real person on the team — friendly, concise (1–2 short lines), and genuinely helpful. Use at most 1 emoji per reply (more only when listing products). Always answer using the business's real facts below; if you don't know something, say you'll have a team member follow up rather than guessing. Never invent prices, policies, or availability.",
  ];

  if (ai.businessContext) {
    lines.push("", "About this business:", ai.businessContext);
  }

  // Business knowledge: free-form notes + imported sources (website, catalog, etc.)
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
      const merged = blocks.join("\n\n").slice(0, 28000);
      lines.push(
        "",
        "BUSINESS KNOWLEDGE — use these facts to answer questions accurately. Never invent details outside this:",
        merged,
      );
    }
  }

  // Sendable images
  const allSources = knowledge?.sources || [];
  const imageSources = allSources.filter(
    (s) => s && s.type === "image" && s.imageUrl && s.status === "ready",
  );
  logger.info(
    `[AI:prompt] ws=${workspace._id} sources=${allSources.length} imageSources=${imageSources.length}`,
  );
  if (imageSources.length) {
    lines.push(
      "",
      "─── SENDABLE IMAGES ───",
      "You CAN send images in DMs. When the customer asks for the menu, catalog, price list, or any image — output <<SEND_IMAGE:URL>> as the VERY FIRST LINE of your reply (before any text). The system delivers the image automatically. Then write your reply below.",
      "FORMAT — marker must be first line, exact URL, no spaces inside << >>:",
      "<<SEND_IMAGE:THE_IMAGE_URL>>",
      "Here's our menu! Let me know if you have questions 😊",
      "",
      "Available images:",
    );
    imageSources.forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.label || "image"} — ${s.imageUrl}`);
    });
    lines.push(
      "NEVER say you cannot send images. NEVER skip the marker when the customer asks for an image.",
      "─── END SENDABLE IMAGES ───",
    );
  }

  // Smart Orders
  const smartOrders = workspace.smartOrders;
  if (smartOrders?.enabled && smartOrders?.catalog?.trim()) {
    lines.push(
      "",
      "─── SMART ORDERS MODE ───",
      "You are a sales assistant. Use EXACT prices and product names from the catalog. Never invent items or prices.",
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
      "When a customer wants to order, collect: product + qty + variant, full name, delivery address, phone, payment method.",
      "Ask 1-2 fields at a time — conversational, not a form. Confirm prices as you go.",
      "",
      "When ALL collected emit ONCE on its own line:",
      '<<ORDER_JSON>>{"items":[{"name":"<product>","qty":<int>,"variant":"<size/color or empty>","price":<unit price number>}],"customerName":"<full name>","customerAddress":"<full address>","customerPhone":"<phone or empty>","paymentMethod":"<method>","subtotal":<total number>,"currency":"<PKR/USD/etc>","notes":"<any extra notes>"}<<END_ORDER>>',
      "The order block is never shown to the customer. Write a friendly confirmation above it.",
      "─── END SMART ORDERS ───",
    );
  }

  if (Array.isArray(ai.faqs) && ai.faqs.length) {
    lines.push(
      "",
      "QUICK ANSWERS — use these verbatim when the question matches:",
    );
    ai.faqs
      .filter((f) => f && f.question && f.answer)
      .slice(0, 30)
      .forEach((f, i) => {
        lines.push(`${i + 1}. Q: ${f.question}\n   A: ${f.answer}`);
      });
  }

  // Goals
  const GOAL_TEXT = {
    support: "Answer questions accurately and helpfully.",
    sales: "Recommend relevant products and gently guide toward a purchase.",
    leads:
      "Spot genuine interest and turn the person into a lead. Be helpful first.",
    bookings: "Help the person book or schedule, collect the details needed.",
    traffic:
      "When relevant, point to the right link instead of long explanations.",
  };
  const goals =
    Array.isArray(v2.goals) && v2.goals.length ? v2.goals : ["support"];
  const goalLines = goals.map((g) => GOAL_TEXT[g]).filter(Boolean);
  if (goalLines.length) {
    lines.push("", "Your goals on every reply:");
    goalLines.forEach((g) => lines.push(`- ${g}`));
  }
  if (v2.leadCapture) {
    lines.push(
      "When someone shows real interest, naturally ask for name + contact (email or phone) to follow up. Ask once.",
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
    lines.push(`When helpful, share this link: ${String(v2.ctaLink).trim()}`);
  }

  // Live integration data
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
  lines.push("", `Customer identifier: ${handle}`);
  lines.push("Channel: Instagram DM");
  lines.push(
    "",
    "REPLY RULES:",
    "- Keep replies short and natural — 1 to 4 lines normally.",
    "- When listing products, prices, or options: one item per line starting with •",
    "  Example: • Classic Hoodie — PKR 2,500 | Sizes: S M L XL | In stock ✅",
    "- If a customer asks about a specific product, give the full details: name, price, sizes, stock, link.",
    "- Split long replies into 2–3 short messages naturally (use newlines, not walls of text).",
    "- Plain text only — Instagram DMs don't render markdown. No **bold**, no #headers, no tables.",
    "- Never invent prices, links, addresses, or policies you weren't told.",
    "- If the user clearly wants a human: respond with ESCALATE: <short reason>",
    "- Never pretend to be human. Never fabricate facts.",
  );

  return lines.join("\n");
};

/**
 * Generate a chatbot reply.
 * Provider priority: openai (gpt-4o-mini) → groq (fallback)
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
  if (!ai.handoffKeywords && workspace.aiBot?.escalateOnKeywords)
    ai.handoffKeywords = workspace.aiBot.escalateOnKeywords;

  // 1. Early escalation by keyword
  const escalateKw = ai.handoffKeywords || ["human", "agent", "support"];
  const lower = (userMessage || "").toLowerCase();
  let escalate = escalateKw.some((kw) =>
    lower.includes(String(kw).toLowerCase()),
  );

  // 2. Instant FAQ match (skip if live data or sendable images involved)
  const hasSendableImages = (workspace.aiKnowledge?.sources || []).some(
    (s) => s && s.type === "image" && s.imageUrl && s.status === "ready",
  );
  logger.info(
    `[AI:generateReply] ws=${workspace?._id} msg="${(userMessage || "").slice(0, 60)}" hasSendableImages=${hasSendableImages}`,
  );
  if (!escalate && !extraContext && !hasSendableImages) {
    const faqHit = matchFaq(ai.faqs, userMessage);
    if (faqHit) {
      logger.info(`[AI:generateReply] ws=${workspace?._id} → FAQ match`);
      return {
        reply: faqHit.answer,
        escalate: false,
        tokens: 0,
        provider: "faq",
      };
    }
  }

  // 3. Determine provider — OpenAI first, Groq fallback
  const requested = (ai.provider || "openai").toLowerCase();
  let client = null;
  let model = null;
  let providerUsed = null;

  if (requested === "openai" || requested === "auto") {
    client = getOpenaiClient();
    model = "gpt-4o-mini";
    providerUsed = "openai";
  }

  if (
    !client &&
    (requested === "groq" || requested === "auto" || requested === "openai")
  ) {
    client = getGroqClient();
    model = "llama-3.3-70b-versatile";
    providerUsed = "groq";
  }

  // Final fallback chain
  if (!client) {
    client = getOpenaiClient();
    if (client) {
      model = "gpt-4o-mini";
      providerUsed = "openai";
    }
  }
  if (!client) {
    client = getGroqClient();
    if (client) {
      model = "llama-3.3-70b-versatile";
      providerUsed = "groq";
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
        ...history.slice(-12),
        { role: "user", content: userMessage || "" },
      ],
      temperature: typeof ai.temperature === "number" ? ai.temperature : 0.45,
      max_tokens: ai.maxTokens || 600,
    });

    let reply =
      response.choices?.[0]?.message?.content?.trim() ||
      "Thanks for your message! A teammate will reply shortly.";

    if (/^\s*ESCALATE\s*:/i.test(reply)) {
      escalate = true;
      reply =
        reply.replace(/^\s*ESCALATE\s*:\s*/i, "").trim() ||
        fallbackReply(contact);
    }

    // Extract <<SEND_IMAGE:url>> markers
    const imageUrls = [];
    logger.info(
      `[AI:raw] ws=${workspace?._id} provider=${providerUsed} raw="${(reply || "").slice(0, 150).replace(/\n/g, "\\n")}"`,
    );
    reply = reply
      .replace(/<<\s*SEND_IMAGE\s*:\s*([^>]+?)\s*>>/gi, (_, url) => {
        const clean = String(url).trim();
        if (/^https?:\/\//i.test(clean)) imageUrls.push(clean);
        return "";
      })
      .trim();

    logger.info(
      `[AI:reply] ws=${workspace?._id} imageUrls=${imageUrls.length}`,
    );

    return {
      reply,
      escalate,
      imageUrls,
      tokens: response.usage?.total_tokens || 0,
      provider: providerUsed,
    };
  } catch (err) {
    logger.error(`AI generateReply (${providerUsed}) failed`, {
      err: err.message,
    });
    // Try Groq as emergency fallback if OpenAI failed
    if (providerUsed === "openai") {
      const groq = getGroqClient();
      if (groq) {
        try {
          const sp = buildSystemPrompt(workspace, contact, extraContext);
          const r2 = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
              { role: "system", content: sp },
              ...history.slice(-12),
              { role: "user", content: userMessage || "" },
            ],
            temperature: 0.45,
            max_tokens: 600,
          });
          const reply2 =
            r2.choices?.[0]?.message?.content?.trim() || fallbackReply(contact);
          return {
            reply: reply2,
            escalate,
            imageUrls: [],
            tokens: r2.usage?.total_tokens || 0,
            provider: "groq-fallback",
          };
        } catch {
          /* fall through */
        }
      }
    }
    return {
      reply: fallbackReply(contact),
      escalate: true,
      tokens: 0,
      provider: providerUsed,
    };
  }
};

/**
 * Return the first available chat client (OpenAI preferred, Groq fallback).
 */
const getAnyClient = () => {
  let client = getOpenaiClient();
  if (client) return { client, model: "gpt-4o-mini", provider: "openai" };
  client = getGroqClient();
  if (client)
    return { client, model: "llama-3.3-70b-versatile", provider: "groq" };
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
