/**
 * Botlify — Unified AI provider abstraction.
 *
 * Gemini is the ONLY provider for the AI bot (replies, knowledge distillation,
 * vision/PDF). Groq is kept solely for the Hashtag Research feature.
 *
 *   • Replies / vision / PDF → gemini-2.5-flash   (quality the customer sees)
 *   • Bulk website-crawl distill → gemini-2.5-flash-lite (cheap, high volume)
 *   • Hashtags only → Groq (see openaiService.getGroqPreferredClient)
 *
 * Gemini exposes an OpenAI-compatible endpoint, so we reuse the `openai` SDK
 * pointed at Google's base URL. (The npm package is just the HTTP client — no
 * OpenAI account or key is used anywhere anymore.)
 */
const logger = require("../../utils/logger");

let groqClient = null;
let geminiClient = null;

// gemini-flash-lite-latest is the model confirmed working on this key's
// OpenAI-compatible endpoint (gemini-2.5-flash and gemini-flash-latest both 404
// there right now). Flash-Lite handles DM replies + vision/PDF well and is the
// cheapest. Both overridable via env if a better model becomes available.
// Primary model — replies + vision/PDF.
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
// Bulk model — website-crawl distillation.
const GEMINI_LITE_MODEL =
  process.env.GEMINI_LITE_MODEL || "gemini-flash-lite-latest";

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
    logger.warn("openai SDK not installed (used by Groq client)");
    return null;
  }
};

// Google Gemini via its OpenAI-compatible endpoint. Botlify's only AI-bot
// provider — high accuracy, natively multimodal, generous free tier.
const getGeminiClient = () => {
  if (geminiClient) return geminiClient;
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const OpenAI = require("openai");
    geminiClient = new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });
    return geminiClient;
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
const buildSystemPrompt = (workspace, contact, extraContext, appointmentBlock) => {
  const v2 = pickAiCfg(workspace);
  const legacy = workspace.aiBot || {};
  const ai = {
    systemPrompt: v2.systemPrompt || legacy.personality,
    businessContext: v2.businessContext || legacy.businessInfo,
    faqs: v2.faqs && v2.faqs.length ? v2.faqs : legacy.faqs,
    aiRole: v2.aiRole,
    brandVoice: v2.brandVoice,
    guardrails: v2.guardrails,
  };

  const bizName =
    workspace.name || workspace.instagram?.username || "this business";

  // AI Role — the persona. Prefer the explicit aiRole field, then a legacy
  // systemPrompt, then a sensible default.
  const role =
    (ai.aiRole && ai.aiRole.trim()) ||
    (ai.systemPrompt && ai.systemPrompt.trim()) ||
    `You are the Instagram assistant for ${bizName} — a warm, sharp member of the team replying to DMs, comments and story replies. You sound like a real person who genuinely cares: friendly, concise, and helpful, never robotic or salesy.`;

  const lines = [role, ""];

  // Brand voice — user-defined tone/format rules, else a strong default.
  lines.push("BRAND VOICE:");
  if (ai.brandVoice && ai.brandVoice.trim()) {
    lines.push(ai.brandVoice.trim());
  } else {
    lines.push(
      "- Speak as 'we' / 'us' for the business, never in third person.",
      "- Warm and human, but efficient — most replies are 1–3 short lines.",
      "- Match the customer's energy and formality. Mirror their language exactly.",
      "- Use at most 1 emoji per reply (a few more only when listing products).",
    );
  }

  lines.push(
    "",
    "ACCURACY IS EVERYTHING:",
    "- Only state facts you were given below (business info, knowledge, FAQs, catalog, live data).",
    "- NEVER invent prices, availability, delivery times, addresses, links, or policies.",
    "- If you genuinely don't know, say so honestly and offer to have a teammate follow up — do NOT guess or make something up.",
    "- If a customer asks something off-topic or unrelated to the business, gently steer back to how you can help them here.",
  );

  // Guardrails — explicit "never do" rules from the user.
  if (ai.guardrails && ai.guardrails.trim()) {
    lines.push("", "STRICT GUARDRAILS — never break these:", ai.guardrails.trim());
  }

  if (ai.businessContext) {
    lines.push("", "About this business:", ai.businessContext);
  }

  // Product catalog (Phase 3) — structured items the bot may quote exactly.
  const catalog = Array.isArray(v2.productCatalog) ? v2.productCatalog : [];
  const validCatalog = catalog.filter((p) => p && p.name);
  if (validCatalog.length) {
    lines.push(
      "",
      "PRODUCT CATALOG — quote these EXACTLY, never invent items or prices:",
    );
    validCatalog.slice(0, 100).forEach((p) => {
      const bits = [`• ${p.name}`];
      if (p.price) bits.push(`— ${p.price}`);
      if (p.inStock === false) bits.push("(out of stock)");
      if (p.description) bits.push(`| ${p.description}`);
      lines.push(bits.join(" "));
    });
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
      '<<ORDER_JSON>>{"items":[{"name":"<product>","qty":<int>,"variant":"<size/color or empty>","price":<unit price number>}],"customerName":"<full name>","customerAddress":"<full address>","customerPhone":"<phone or empty>","paymentMethod":"<method>","subtotal":<total number>,"currency":"<USD/etc>","notes":"<any extra notes>"}<<END_ORDER>>',
      "The order block is never shown to the customer. Write a friendly confirmation above it.",
      "─── END SMART ORDERS ───",
    );
  }

  // Appointment scheduling — the block (open slots + services) is precomputed in
  // generateReply so this stays synchronous.
  if (appointmentBlock && appointmentBlock.trim()) {
    lines.push("", appointmentBlock.trim());
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
    "- Never pretend to be human. Never fabricate facts. Never argue — stay calm and kind even if the customer is upset.",
    "",
    "WHEN TO HAND OFF TO A HUMAN — reply with exactly `ESCALATE: <short reason>` (and nothing else) if:",
    "- The customer explicitly asks for a human, manager, owner, or 'real person'.",
    "- They're angry, making a serious complaint, or threatening a refund/chargeback/legal action.",
    "- They need something you genuinely cannot do or don't have the information for.",
    "- The request is sensitive (payment dispute, personal data, account access).",
    "Otherwise, keep helping them yourself — don't escalate for normal questions you can answer.",
  );

  // ── Intent tag (Phase 4) — the model labels each message so we can route &
  // analyse. Emitted on its own line; the system strips it before sending.
  lines.push(
    "",
    "INTENT — start your reply with ONE hidden tag line, then your reply below it:",
    "<<INTENT:one_of[greeting, question, pricing, availability, order, booking, support, complaint, lead, spam, other]>>",
    "Example:",
    "<<INTENT:pricing>>",
    "Our serum is Rs 2,500 😊 Want me to send the link?",
  );

  // ── Actions/tools (Phase 5) — the agent can DO things by emitting markers on
  // their own lines. Only enable the ones turned on in settings.
  const actions = v2.actions || {};
  const actionLines = [];
  if (actions.autoTag !== false) {
    actionLines.push(
      "- Tag the customer when useful: <<TAG:tag_name>> (e.g. <<TAG:interested>>, <<TAG:vip>>, <<TAG:complaint>>).",
    );
  }
  if (actions.captureLead !== false) {
    actionLines.push(
      "- When a customer shows real buying/booking interest and you learn their name + a contact (email or phone), record it once: <<LEAD:name=Full Name;contact=email-or-phone>>.",
    );
  }
  if (actionLines.length) {
    lines.push(
      "",
      "ACTIONS — you may add these marker lines ABOVE your reply. Markers are hidden from the customer; never mention them:",
      ...actionLines,
    );
  }

  return lines.join("\n");
};

/**
 * Strip ALL internal markers from a raw model reply and pull out their data.
 * Runs on EVERY reply path (primary + fallback) so nothing like <<INTENT:...>>
 * can ever leak to the customer. Returns { reply, imageUrls, intent, tags, lead }.
 */
const parseMarkers = (raw) => {
  let reply = String(raw || "");
  const imageUrls = [];
  reply = reply.replace(/<<\s*SEND_IMAGE\s*:\s*([^>]+?)\s*>>/gi, (_, url) => {
    const clean = String(url).trim();
    if (/^https?:\/\//i.test(clean)) imageUrls.push(clean);
    return "";
  });

  let intent = null;
  reply = reply.replace(/<<\s*INTENT\s*:\s*([^>]+?)\s*>>/gi, (_, val) => {
    if (!intent) intent = String(val).toLowerCase().trim();
    return "";
  });

  const tags = [];
  reply = reply.replace(/<<\s*TAG\s*:\s*([^>]+?)\s*>>/gi, (_, t) => {
    const clean = String(t).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (clean) tags.push(clean);
    return "";
  });

  let lead = null;
  reply = reply.replace(/<<\s*LEAD\s*:\s*([^>]+?)\s*>>/i, (_, body) => {
    const out = {};
    String(body)
      .split(";")
      .forEach((kv) => {
        const [k, ...rest] = kv.split("=");
        if (k && rest.length) out[k.trim().toLowerCase()] = rest.join("=").trim();
      });
    if (out.name || out.contact) lead = out;
    return "";
  });

  // Smart Orders — the model emits <<ORDER_JSON>>{...}<<END_ORDER>>. Parse it out
  // (before the catch-all below deletes it) so the order is actually recorded.
  let order = null;
  reply = reply.replace(
    /<<\s*ORDER_JSON\s*>>([\s\S]*?)<<\s*END_ORDER\s*>>/i,
    (_, json) => {
      try {
        const parsed = JSON.parse(String(json).trim());
        if (parsed && Array.isArray(parsed.items) && parsed.items.length) {
          order = parsed;
        }
      } catch {
        /* malformed order block — ignore */
      }
      return "";
    },
  );

  // Appointment booking — the model emits <<BOOK_APPOINTMENT_JSON>>{...}<<END_BOOK>>
  // once it has collected service + time + name. Parse before the catch-all.
  let booking = null;
  reply = reply.replace(
    /<<\s*BOOK_APPOINTMENT_JSON\s*>>([\s\S]*?)<<\s*END_BOOK\s*>>/i,
    (_, json) => {
      try {
        const parsed = JSON.parse(String(json).trim());
        if (parsed && parsed.startAt) booking = parsed;
      } catch {
        /* malformed booking block — ignore */
      }
      return "";
    },
  );

  // SAFETY NET: remove ANY remaining << … >> marker in any format the model
  // might invent, then tidy whitespace.
  reply = reply
    .replace(/<<[^>]*>>/g, "")
    .replace(/^\s*INTENT\s*:.*$/gim, "") // bare "INTENT: x" without brackets
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { reply, imageUrls, intent, tags, lead, order, booking };
};

/**
 * Build the appointment-scheduling prompt block with LIVE open slots so the bot
 * only ever offers real, bookable times. Returns "" when scheduling is off.
 */
const buildAppointmentBlock = async (workspace) => {
  const cfg = workspace.appointments;
  if (!cfg?.enabled) return "";
  let slots = [];
  try {
    const { getAvailableSlots } = require("../appointments/slotEngine");
    slots = await getAvailableSlots(workspace, { limit: 10 });
  } catch (e) {
    logger.warn("[AI] slot fetch failed", { err: e.message });
  }

  const services = (cfg.services || []).filter((s) => s && s.name);
  const svcLines = services.length
    ? services
        .map(
          (s) =>
            `  • ${s.name} (${s.durationMinutes || cfg.slotMinutes || 30} min${s.price ? `, ${s.price}` : ""})`,
        )
        .join("\n")
    : "  • (general appointment)";

  const slotLines = slots.length
    ? slots.map((s) => `  • ${s.label}  [${s.startAt.toISOString()}]`).join("\n")
    : "  (no open slots in the near future — offer to take their details and have the team follow up)";

  const loc = cfg.locationName || cfg.locationAddress;
  const out = [
    "─── APPOINTMENT SCHEDULING MODE ───",
    "This business takes appointments. Help the customer book into a REAL open slot below. Never invent a time that isn't listed.",
    "",
    "SERVICES:",
    svcLines,
    "",
    "OPEN SLOTS (offer 2–3 nearest that suit them; the bracketed value is the exact machine time — never show the bracket to the customer):",
    slotLines,
  ];
  if (loc) out.push("", `LOCATION: ${loc}${cfg.mapsUrl ? ` — ${cfg.mapsUrl}` : ""}`);
  out.push(
    "",
    "To book: collect the service, a chosen slot, the customer's name, and phone. Ask 1–2 things at a time, conversationally.",
    "When you have service + time + name, emit ONCE on its own line (never shown to the customer):",
    '<<BOOK_APPOINTMENT_JSON>>{"service":"<service name>","startAt":"<exact ISO time from the chosen slot bracket>","customerName":"<full name>","customerPhone":"<phone or empty>","notes":"<anything relevant>"}<<END_BOOK>>',
    "Write a warm confirmation above the block. Use the EXACT bracketed ISO time of the slot they picked.",
    cfg.requireApproval
      ? "Bookings need team approval — tell the customer you've REQUESTED the slot and will confirm shortly."
      : "Bookings are instant — tell the customer they're confirmed.",
    "─── END APPOINTMENT SCHEDULING ───",
  );
  return out.join("\n");
};

/**
 * Generate a chatbot reply.
 * Provider priority: openai → gemini → groq (fallback)
 */
const generateReply = async ({
  workspace,
  history = [],
  userMessage,
  contact,
  extraContext = null,
  incomingImageUrl = null,
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
  // Skip the instant-FAQ shortcut when the customer sent an image — a photo
  // needs the vision model to actually look at it.
  if (!escalate && !extraContext && !hasSendableImages && !incomingImageUrl) {
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

  // 3. AI bot runs on Gemini only.
  const client = getGeminiClient();
  const model = GEMINI_MODEL;
  const providerUsed = "gemini";

  if (!client) {
    return {
      reply: fallbackReply(contact),
      escalate: true,
      tokens: 0,
      provider: "none",
    };
  }

  const appointmentBlock = await buildAppointmentBlock(workspace);
  const systemPrompt = buildSystemPrompt(
    workspace,
    contact,
    extraContext,
    appointmentBlock,
  );

  // If the customer sent a photo, build a multimodal user turn so the vision
  // model actually looks at it. Falls back to a plain text turn otherwise.
  const userTurn = incomingImageUrl
    ? {
        role: "user",
        content: [
          {
            type: "text",
            text:
              userMessage && userMessage.trim()
                ? userMessage
                : "The customer sent this image. Look at it and reply helpfully about our business.",
          },
          { type: "image_url", image_url: { url: incomingImageUrl } },
        ],
      }
    : { role: "user", content: userMessage || "" };

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.slice(-12),
        userTurn,
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

    logger.info(
      `[AI:raw] ws=${workspace?._id} provider=${providerUsed} raw="${(reply || "").slice(0, 150).replace(/\n/g, "\\n")}"`,
    );
    // Parse & strip ALL internal markers (image/intent/tag/lead + safety net).
    const parsed = parseMarkers(reply);
    reply = parsed.reply || fallbackReply(contact);
    const { imageUrls, intent, tags, lead, order, booking } = parsed;

    logger.info(
      `[AI:reply] ws=${workspace?._id} intent=${intent || "-"} tags=[${tags.join(",")}] lead=${lead ? "yes" : "no"} order=${order ? "yes" : "no"} booking=${booking ? "yes" : "no"} imageUrls=${imageUrls.length}`,
    );

    return {
      reply,
      escalate,
      imageUrls,
      intent,
      tags,
      lead,
      order,
      booking,
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
 * Return the AI-bot chat client. Gemini only.
 */
const getAnyClient = () => {
  const client = getGeminiClient();
  if (client) return { client, model: GEMINI_MODEL, provider: "gemini" };
  return { client: null, model: null, provider: "none" };
};

/**
 * Low-level one-shot completion used by tools like the website importer.
 * Returns the text content, or null if Gemini isn't configured / it fails.
 *
 * @param {object} opts
 * @param {boolean} [opts.lite]  use the cheaper flash-lite model (bulk work).
 */
const complete = async ({
  system,
  user,
  maxTokens = 700,
  temperature = 0.3,
  lite = false,
}) => {
  const client = getGeminiClient();
  const model = lite ? GEMINI_LITE_MODEL : GEMINI_MODEL;
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
  // Vision runs on Gemini (native multimodal, accepts base64 image URLs).
  const client = getGeminiClient();
  if (!client) return null;
  const model = GEMINI_MODEL;
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

/**
 * Read a whole PDF with Gemini's NATIVE multimodal API (inlineData). Used when
 * the embedded text layer is missing — designed menus, scanned catalogs, image
 * PDFs. Gemini reads text AND images across every page (up to ~1000 pages).
 * The OpenAI-compat endpoint doesn't accept PDFs, so we use @google/generative-ai.
 */
let nativeGenAI = null;
const getNativeGemini = () => {
  if (!process.env.GEMINI_API_KEY) return null;
  if (nativeGenAI) return nativeGenAI;
  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    nativeGenAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    return nativeGenAI;
  } catch (e) {
    logger.warn("[getNativeGemini] SDK not available", { err: e.message });
    return null;
  }
};

const PDF_INSTRUCTION =
  "This is a business document (a menu, price list, catalog, or brochure). " +
  "Read EVERY page carefully. Transcribe ALL items/products with their exact " +
  "prices and key details (sizes, variants, sections). Preserve section " +
  "headings. Miss nothing. Output clean plain text only — no commentary.";

// Upload a big PDF via the Gemini File API, then read it. Handles large image
// PDFs (menus/catalogs) that are too big for inline data.
const readPdfViaFileApi = async (buffer) => {
  if (!process.env.GEMINI_API_KEY) return "";
  try {
    const { GoogleAIFileManager, FileState } = require(
      "@google/generative-ai/server",
    );
    const fm = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
    // The SDK's file manager reads from disk, so stage a temp file.
    const os = require("os");
    const path = require("path");
    const fs = require("fs");
    const tmp = path.join(
      os.tmpdir(),
      `botlify-${Date.now()}-${Math.round(Math.random() * 1e6)}.pdf`,
    );
    fs.writeFileSync(tmp, buffer);
    let uploaded;
    try {
      uploaded = await fm.uploadFile(tmp, { mimeType: "application/pdf" });
      // Wait for the file to finish processing.
      let file = uploaded.file;
      for (let i = 0; i < 30 && file.state === FileState.PROCESSING; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        file = await fm.getFile(uploaded.file.name);
      }
      if (file.state !== FileState.ACTIVE) {
        logger.warn("[readPdfViaFileApi] file not active", {
          state: file.state,
        });
        return "";
      }
      const genAI = getNativeGemini();
      const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
      const result = await model.generateContent([
        { text: PDF_INSTRUCTION },
        {
          fileData: {
            mimeType: uploaded.file.mimeType,
            fileUri: uploaded.file.uri,
          },
        },
      ]);
      return result.response?.text()?.trim() || "";
    } finally {
      fs.unlink(tmp, () => {});
      if (uploaded?.file?.name) fm.deleteFile(uploaded.file.name).catch(() => {});
    }
  } catch (err) {
    logger.error("[readPdfViaFileApi] failed", { err: err.message });
    throw err; // let the caller surface the real reason (e.g. quota)
  }
};

const readPdfWithVision = async (buffer) => {
  // PDFs are read by Gemini's native multimodal API (reads text + images across
  // every page). Big/image PDFs use the File API; small ones go inline.
  const genAI = getNativeGemini();
  if (!genAI) {
    logger.warn("[readPdfWithVision] no GEMINI_API_KEY configured");
    return "";
  }

  let lastErr = null;
  // Big or image-heavy PDFs → use the File API (handles up to ~1000 pages / 2GB
  // and processes far more reliably than inline base64). Small PDFs → inline.
  if (buffer.length > 6 * 1024 * 1024) {
    try {
      const viaFile = await readPdfViaFileApi(buffer);
      if (viaFile) return viaFile;
    } catch (err) {
      lastErr = err;
    }
  }

  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent([
      { text: PDF_INSTRUCTION },
      {
        inlineData: {
          mimeType: "application/pdf",
          data: buffer.toString("base64"),
        },
      },
    ]);
    const out = result.response?.text()?.trim() || "";
    if (out) return out;
  } catch (err) {
    lastErr = err;
    logger.warn("[readPdfWithVision] inline failed, trying File API", {
      err: err.message,
    });
  }

  // Last resort: File API even for smaller files if inline errored.
  try {
    const viaFile = await readPdfViaFileApi(buffer);
    if (viaFile) return viaFile;
  } catch (err) {
    lastErr = err;
  }

  // Nothing worked. Re-throw the real error (e.g. quota) so the caller can show
  // an honest message instead of a generic "couldn't read".
  if (lastErr) throw lastErr;
  return "";
};

/**
 * Diagnostic: is Gemini configured AND actually answering? Returns a small
 * object we can surface to confirm the key + model work on the live server.
 */
const healthCheck = async () => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  const out = {
    hasGeminiKey: hasKey,
    configuredModel: GEMINI_MODEL,
    configuredLite: GEMINI_LITE_MODEL,
    ok: false,
    reply: null,
    workingModel: null,
    triedModels: [],
    availableModels: null,
    error: null,
  };
  if (!hasKey) {
    out.error = "GEMINI_API_KEY is not set on the server";
    return out;
  }
  const client = getGeminiClient();

  // 1. List the models this key can actually use (the live source of truth).
  try {
    const axios = require("axios");
    const { data } = await axios.get(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { params: { key: process.env.GEMINI_API_KEY }, timeout: 12000 },
    );
    out.availableModels = (data.models || [])
      .map((m) => (m.name || "").replace(/^models\//, ""))
      .filter((n) => /gemini/i.test(n))
      .slice(0, 40);
  } catch (err) {
    out.availableModels = `list failed: ${err.response?.status || err.message}`;
  }

  // 2. Try candidate models until one answers, so we know exactly what works.
  const candidates = [
    GEMINI_MODEL,
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-2.0-flash",
  ];
  for (const model of candidates) {
    if (out.triedModels.includes(model)) continue;
    out.triedModels.push(model);
    try {
      const r = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 5,
      });
      const reply = r.choices?.[0]?.message?.content?.trim() || null;
      if (reply) {
        out.ok = true;
        out.reply = reply;
        out.workingModel = model;
        break;
      }
    } catch (err) {
      if (!out.error)
        out.error =
          err?.response?.data?.error?.message ||
          `${err.message} (model ${model})`;
    }
  }
  return out;
};

module.exports = {
  generateReply,
  buildSystemPrompt,
  getAnyClient,
  complete,
  completeVision,
  readPdfWithVision,
  healthCheck,
};
