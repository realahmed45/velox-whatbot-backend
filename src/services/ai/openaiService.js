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
  const client = getClient();
  if (!client) {
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
      model: "gpt-4o-mini",
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
  const client = getClient();
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
      model: cfg.model || "gpt-4o-mini",
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
  const client = getClient();
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
      model: "gpt-4o-mini",
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
  const client = getClient();
  if (!client || !text) {
    return { hide: false, reason: null };
  }

  // Quick local check first (cheap)
  const lower = text.toLowerCase();
  const profanity = ["fuck", "shit", "bitch", "asshole", "dick", "bastard"];
  if (profanity.some((w) => lower.includes(w))) {
    return { hide: true, reason: "profanity" };
  }
  if (competitorNames.some((c) => c && lower.includes(c.toLowerCase()))) {
    return { hide: true, reason: "competitor_mention" };
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
  const client = getClient();
  if (!client || !topic) {
    return {
      hashtags: {
        big: [],
        medium: [],
        niche: [],
      },
      tokens: 0,
    };
  }

  try {
    const prompt = `Generate ${count} relevant Instagram hashtags for the topic: "${topic}".
Group them by popularity:
- big: 3-5 hashtags that are very popular (>1M posts) — high reach, high competition
- medium: 10-15 hashtags that are moderately popular (100K-1M posts) — balanced
- niche: 10-15 hashtags that are specific to this niche (<100K posts) — high engagement

Language: ${language === "ur" ? "Roman Urdu / English mix for Pakistani audience" : "English"}

Return JSON: { "hashtags": { "big": ["#tag1",...], "medium": ["#tag2",...], "niche": ["#tag3",...] } }`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
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

    const tokens = response.usage?.total_tokens || 0;
    const parsed = JSON.parse(response.choices[0].message.content);
    return {
      hashtags: parsed.hashtags || { big: [], medium: [], niche: [] },
      tokens,
    };
  } catch (err) {
    logger.error("researchHashtags failed", { err: err.message });
    return {
      hashtags: { big: [], medium: [], niche: [] },
      tokens: 0,
      error: err.message,
    };
  }
};

/**
 * Transcribe an audio file (e.g. Instagram voice DM) using Whisper.
 * @param {Object} opts
 * @param {string} opts.url — HTTPS URL of the audio file
 * @returns {Promise<{text:string, error?:string}>}
 */
const transcribeAudio = async ({ url }) => {
  const client = getClient();
  if (!client) return { text: "", error: "OpenAI not configured" };
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
