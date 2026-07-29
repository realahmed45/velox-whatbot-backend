/**
 * Botlify — OpenAI Conversational Bot (Scale / Premium plan)
 * Generates contextual replies using chat history + workspace personality.
 */
const logger = require("../../utils/logger");

const GEMINI_MODEL = "gemini-2.0-flash";

// Google Gemini via its OpenAI-compatible endpoint — Botlify's primary AI.
let geminiClient = null;
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
    logger.warn("openai SDK not installed: run `npm install openai`");
    return null;
  }
};

// Groq fallback. Groq is OpenAI-API compatible, so we reuse the OpenAI SDK
// pointed at Groq's endpoint. Used when no GEMINI_API_KEY is configured.
let groqClient = null;
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
    return null;
  }
};

const GROQ_MODEL = "llama-3.3-70b-versatile";

// Provider selection lives in the main AI service (OpenAI → Gemini → Groq).
// Delegate to it so this utility file always matches. Returns { client, model }
// or null.
const getUtilityClient = () => {
  try {
    const { getAnyClient } = require("./index");
    const svc = getAnyClient();
    if (svc?.client) return { client: svc.client, model: svc.model };
  } catch {
    /* fall through */
  }
  const gm = getGeminiClient();
  if (gm) return { client: gm, model: GEMINI_MODEL };
  const gq = getGroqClient();
  if (gq) return { client: gq, model: GROQ_MODEL };
  return null;
};

// Prefer Groq explicitly for lightweight text tasks (hashtags, captions) so
// they work deterministically while OpenAI isn't configured. Falls back to the
// general chain if Groq isn't available.
const getGroqPreferredClient = () => {
  const gq = getGroqClient();
  if (gq) return { client: gq, model: GROQ_MODEL };
  return getUtilityClient();
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
  const svc = getUtilityClient();
  const client = svc?.client || null;
  const cfg = workspace.aiBot || {};
  const personality =
    cfg.personality ||
    "You are a friendly, professional assistant for our Instagram business.";
  const businessInfo = cfg.businessInfo || "";
  const model = svc?.model || "gemini-2.0-flash";
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
    (() => {
      const LANG_NAMES = {
        en: "English",
        ur: "Urdu (but use Roman/English script unless the customer writes in Urdu script)",
        ar: "Arabic",
        es: "Spanish",
        fr: "French",
        hi: "Hindi (Roman script unless the customer writes in Devanagari)",
      };
      const lang = workspace.language || "en";
      return `\nReply in ${LANG_NAMES[lang] || "English"}. If the customer clearly writes in a different language, mirror theirs instead.`;
    })(),
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

/**
 * Generate an Instagram caption + hashtags from a topic/image description.
 * @param {Object} opts
 * @param {string} opts.topic        — what the post is about
 * @param {string} [opts.brandVoice] — optional personality string
 * @param {string} [opts.tone]       — casual | professional | funny | inspirational | salesy
 * @param {number} [opts.count]      — how many caption variations to return (1-5)
 * @param {string} [opts.language]   — 'en' | 'ur' | 'both'
 */
const generateCaption = async ({
  topic,
  brandVoice = "",
  tone = "casual",
  count = 3,
  language = "en",
}) => {
  const svc = getUtilityClient();
  if (!svc) {
    return {
      captions: [
        {
          text: `${topic} ✨\n\nTap the link in bio to learn more!`,
          hashtags: ["#instagram", "#business", "#content"],
        },
      ],
      tokens: 0,
    };
  }
  const { client, model } = svc;

  const langInstr =
    language === "ur"
      ? "Write captions in Roman Urdu (Urdu written in English letters)."
      : language === "both"
        ? "Write one caption in English and one in Roman Urdu."
        : "Write captions in English.";

  const prompt = `Write ${count} Instagram caption variations for this topic: "${topic}".
${brandVoice ? `Brand voice: ${brandVoice}` : ""}
Tone: ${tone}.
${langInstr}

Rules:
- Each caption 2-4 short lines max.
- Add a clear CTA (ask a question, tell them to comment/DM, or tap link in bio).
- Use 1-3 relevant emojis.
- Keep under 500 characters.
- Also provide 8-12 trending, relevant hashtags (mix of popular + niche).

Return as JSON: { "captions": [ { "text": "...", "hashtags": ["#tag1", "#tag2"] } ] }`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an expert Instagram copywriter who writes viral, conversion-focused captions. Always return valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.9,
      max_tokens: 800,
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    return {
      captions: parsed.captions || [],
      tokens: response.usage?.total_tokens || 0,
    };
  } catch (err) {
    logger.error("OpenAI generateCaption failed", { err: err.message });
    return { captions: [], tokens: 0, error: err.message };
  }
};

/**
 * Suggest 3 reply drafts for an agent handling a conversation.
 */
const suggestReplies = async ({
  workspace,
  history = [],
  userMessage,
  contact,
}) => {
  const client = getUtilityClient()?.client || null;
  if (!client) {
    return {
      suggestions: [
        "Thanks for reaching out! How can I help?",
        "Hi there! Could you share a bit more detail?",
        "Appreciate the message — let me check and get back to you.",
      ],
      tokens: 0,
    };
  }

  const cfg = workspace?.aiBot || {};
  const sys = `You are helping a human customer-support agent on Instagram draft 3 possible replies.
${cfg.businessInfo ? `Business info:\n${cfg.businessInfo}` : ""}
${cfg.personality ? `Brand voice:\n${cfg.personality}` : ""}
Generate 3 short, warm, distinct reply options the agent can pick from.
Return JSON: { "suggestions": ["...", "...", "..."] }`;

  try {
    const response = await client.chat.completions.create({
      model: getUtilityClient()?.model || "gemini-2.0-flash",
      messages: [
        { role: "system", content: sys },
        ...history.slice(-8),
        { role: "user", content: userMessage || "" },
      ],
      response_format: { type: "json_object" },
      temperature: 0.8,
      max_tokens: 400,
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    return {
      suggestions: parsed.suggestions || [],
      tokens: response.usage?.total_tokens || 0,
    };
  } catch (err) {
    logger.error("OpenAI suggestReplies failed", { err: err.message });
    return { suggestions: [], tokens: 0, error: err.message };
  }
};

/**
 * Fast sentiment + intent classifier for inbound messages.
 * Returns: { sentiment: 'positive'|'neutral'|'negative'|'angry', intent, confidence, urgency }
 */
const analyzeSentiment = async (text) => {
  const svc = getUtilityClient();
  const client = svc?.client || null;
  if (!client || !text) {
    return {
      sentiment: "neutral",
      intent: "unknown",
      urgency: "low",
      confidence: 0,
    };
  }

  try {
    const response = await client.chat.completions.create({
      model: svc?.model || "gemini-2.0-flash",
      messages: [
        {
          role: "system",
          content:
            'Classify the customer message. Return JSON: { "sentiment": "positive"|"neutral"|"negative"|"angry", "intent": "question"|"complaint"|"praise"|"purchase_intent"|"support"|"spam"|"other", "urgency": "low"|"medium"|"high", "confidence": 0-1 }',
        },
        { role: "user", content: text.slice(0, 500) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 100,
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    logger.warn("analyzeSentiment failed", { err: err.message });
    return {
      sentiment: "neutral",
      intent: "unknown",
      urgency: "low",
      confidence: 0,
    };
  }
};

/**
 * Moderate a comment — detect profanity, spam, competitor mention, toxicity.
 */
const moderateComment = async (text, competitorNames = []) => {
  if (!text) return { hide: false, reason: null };

  // Quick local check (cheap, provider-independent). This is the primary
  // moderation path now that we run on Gemini — the OpenAI moderations
  // endpoint below is used only if an OpenAI-compatible client exposes it.
  const lower = text.toLowerCase();
  const profanity = ["fuck", "shit", "bitch", "asshole", "dick", "bastard"];
  if (profanity.some((w) => lower.includes(w))) {
    return { hide: true, reason: "profanity" };
  }
  if (competitorNames.some((c) => c && lower.includes(c.toLowerCase()))) {
    return { hide: true, reason: "competitor_mention" };
  }

  const client = getUtilityClient()?.client || null;
  if (!client || typeof client.moderations?.create !== "function") {
    return { hide: false, reason: null };
  }
  try {
    const response = await client.moderations.create({ input: text });
    const flagged = response.results?.[0]?.flagged;
    if (flagged) {
      const categories = response.results[0].categories || {};
      const reason = Object.keys(categories).find((k) => categories[k]);
      return { hide: true, reason: reason || "flagged" };
    }
    return { hide: false, reason: null };
  } catch (err) {
    return { hide: false, reason: null };
  }
};

/**
 * Research Instagram hashtags for a given niche/topic.
 * Returns hashtags grouped by size: big (>1M), medium (100K-1M), niche (<100K).
 */
const researchHashtags = async ({ topic, language = "en", count = 30 }) => {
  // Prefer Groq for hashtags (works while OpenAI/Gemini are unset).
  const svc = getGroqPreferredClient();
  if (!svc || !topic) {
    // No AI provider — still return useful topic-based hashtags so the feature
    // never comes back empty.
    return {
      hashtags: fallbackHashtags(topic),
      tokens: 0,
      provider: "fallback",
    };
  }
  const { client, model } = svc;

  try {
    const prompt = `Generate ${count} relevant Instagram hashtags for the topic: "${topic}".
Group them by popularity:
- big: 3-5 hashtags that are very popular (>1M posts) — high reach, high competition
- medium: 10-15 hashtags that are moderately popular (100K-1M posts) — balanced
- niche: 10-15 hashtags that are specific to this niche (<100K posts) — high engagement

Language: ${language === "ur" ? "Roman Urdu / English mix for Pakistani audience" : "English"}

Return ONLY valid JSON, no markdown, no code fences, exactly this shape:
{ "hashtags": { "big": ["#tag1"], "medium": ["#tag2"], "niche": ["#tag3"] } }`;

    // Groq's llama models honour response_format=json_object only when the
    // request also contains the literal word "json" (it does above). Some
    // providers/models reject the param outright, so if it throws we retry
    // once without it and rely on the extractor below.
    let response;
    try {
      response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are an Instagram growth expert. Always return valid JSON with relevant, searchable hashtags without spaces.",
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.6,
        max_tokens: 800,
      });
    } catch (fmtErr) {
      logger.warn("researchHashtags: json_object mode failed, retrying plain", {
        err: fmtErr.message,
      });
      response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are an Instagram growth expert. Reply with ONLY a valid JSON object, no markdown or code fences.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.6,
        max_tokens: 800,
      });
    }

    const tokens = response.usage?.total_tokens || 0;
    const raw = response.choices?.[0]?.message?.content || "";
    const hashtags = parseHashtagGroups(raw);
    const total =
      hashtags.big.length + hashtags.medium.length + hashtags.niche.length;
    if (!total) {
      logger.warn("researchHashtags: model returned no usable hashtags", {
        model,
        raw: raw.slice(0, 200),
      });
      // Never leave the user empty-handed.
      return { hashtags: fallbackHashtags(topic), tokens, provider: "fallback" };
    }
    return { hashtags, tokens };
  } catch (err) {
    logger.error("researchHashtags failed", { err: err.message });
    // Groq/network hiccup — still return topic-based hashtags.
    return {
      hashtags: fallbackHashtags(topic),
      tokens: 0,
      provider: "fallback",
      error: err.message,
    };
  }
};

/**
 * Deterministic, no-AI hashtag generator. Builds sensible #tags from the topic
 * plus evergreen Instagram-growth tags, grouped by reach. Guarantees the
 * Hashtag Research feature always returns something useful.
 */
const fallbackHashtags = (topic = "") => {
  const words = String(topic)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const base = words.join("");
  const combos = [];
  if (base) {
    combos.push(`#${base}`, `#${base}s`, `#${base}lover`, `#${base}life`);
    for (const w of words) combos.push(`#${w}`);
    // pairwise combos
    for (let i = 0; i < words.length - 1; i++) {
      combos.push(`#${words[i]}${words[i + 1]}`);
    }
  }
  const big = cleanTags([
    ...combos.slice(0, 2),
    "#instagram",
    "#instagood",
    "#viral",
  ]);
  const medium = cleanTags([
    ...combos.slice(2, 8),
    "#smallbusiness",
    "#instadaily",
    "#explorepage",
    "#contentcreator",
  ]);
  const niche = cleanTags([
    ...combos.slice(8),
    ...words.map((w) => `#${w}community`),
    ...words.map((w) => `#${w}tips`),
    "#supportsmallbusiness",
  ]);
  return { big, medium, niche };
};

/**
 * Parse the model's hashtag response defensively. Handles: markdown code
 * fences, the arrays nested under `hashtags` OR at the top level, a flat
 * array/string of tags, and tags with or without a leading `#`. Always
 * returns { big, medium, niche } of clean, deduped `#tag` strings.
 */
const parseHashtagGroups = (raw) => {
  const empty = { big: [], medium: [], niche: [] };
  if (!raw) return empty;

  // 1. Pull JSON out even if wrapped in ```json fences or surrounding prose.
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  const jsonSlice =
    braceStart !== -1 && braceEnd > braceStart
      ? text.slice(braceStart, braceEnd + 1)
      : text;

  let parsed = null;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    // 2. No parseable JSON — fall back to scraping every #tag from the text.
    const scraped = cleanTags(String(raw).match(/#[\p{L}\p{N}_]+/gu) || []);
    if (scraped.length) return spreadTags(scraped);
    return empty;
  }

  // 3. Normalise to the { big, medium, niche } shape.
  const groups = parsed.hashtags && typeof parsed.hashtags === "object"
    ? parsed.hashtags
    : parsed;

  const pick = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  let big = cleanTags(pick(groups.big));
  let medium = cleanTags(pick(groups.medium));
  let niche = cleanTags(pick(groups.niche));

  // 4. If the model ignored the grouping and returned a flat list, spread it.
  if (!big.length && !medium.length && !niche.length) {
    const flat = cleanTags(
      Array.isArray(parsed) ? parsed : pick(groups.hashtags || groups.tags),
    );
    if (flat.length) return spreadTags(flat);
  }

  return { big, medium, niche };
};

// Ensure every tag is a clean, single-word `#hashtag`, deduped.
const cleanTags = (arr) => {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (item == null) continue;
    let t = String(item).trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!t) continue;
    const tag = "#" + t;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
};

// Distribute a flat list across the three buckets so the UI still renders.
const spreadTags = (flat) => {
  const big = flat.slice(0, 5);
  const medium = flat.slice(5, 18);
  const niche = flat.slice(18);
  return { big, medium, niche };
};

/**
 * Transcribe an audio file (e.g. Instagram voice DM) using Whisper.
 * @param {Object} opts
 * @param {string} opts.url — HTTPS URL of the audio file
 * @returns {Promise<{text:string, error?:string}>}
 */
const transcribeAudio = async ({ url }) => {
  // Voice-note transcription used OpenAI Whisper, which we no longer configure.
  // Degrade gracefully — callers already handle an empty transcript.
  const client = getUtilityClient()?.client || null;
  if (!client || typeof client.audio?.transcriptions?.create !== "function") {
    return { text: "", error: "audio transcription not available" };
  }
  try {
    const axios = require("axios");
    const { data } = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    // Whisper API accepts a File-like. Node 20+ has global File.
    const file = new File([data], "voice.m4a", { type: "audio/m4a" });
    const result = await client.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });
    return { text: result.text || "" };
  } catch (err) {
    logger.warn(`transcribeAudio failed: ${err.message}`);
    return { text: "", error: err.message };
  }
};

module.exports = {
  generateReply,
  generateCaption,
  suggestReplies,
  analyzeSentiment,
  moderateComment,
  researchHashtags,
  transcribeAudio,
};
