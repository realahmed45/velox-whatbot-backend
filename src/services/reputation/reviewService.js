/**
 * reviewService — the reputation engine.
 *
 * Reviews arrive from OTAs (Channex) or from guests we asked directly after
 * checkout. The AI drafts a reply; the owner approves it. We NEVER auto-post —
 * a bot posting on a hotel's public profile unsupervised is not a risk worth
 * taking.
 */
const Review = require("../../models/Review");
const HotelBooking = require("../../models/HotelBooking");
const Property = require("../../models/Property");
const Conversation = require("../../models/Conversation");
const Contact = require("../../models/Contact");
const logger = require("../../utils/logger");

// Booking-sourced stays we may message directly. OTA guests are off-limits —
// contacting them outside the OTA breaks Booking.com/Airbnb terms.
const DIRECT_SOURCES = ["whatsapp", "instagram", "tiktok", "direct", "manual"];

/** Map 1–5 stars to a sentiment bucket. */
const sentimentFor = (stars) =>
  stars <= 2 ? "negative" : stars === 3 ? "neutral" : "positive";

/**
 * Ingest one review, idempotently by externalId. Normalizes whatever scale the
 * source uses down to 1–5 stars.
 *
 * @returns {Promise<{ok, review?, reason?}>}
 */
async function ingestReview({
  workspaceId,
  propertyId,
  source = "direct",
  externalId = null,
  guestName = "",
  rating,
  ratingScale = 5,
  title = "",
  text = "",
  language = "",
  reviewedAt,
  bookingId,
}) {
  try {
    if (!workspaceId) return { ok: false, reason: "missing_workspace" };

    const scale = Number(ratingScale) === 10 ? 10 : 5;
    const raw = Number(rating);
    let stars = scale === 10 ? raw / 2 : raw;
    stars = Math.min(5, Math.max(1, Math.round(stars || 3)));

    const doc = {
      workspaceId,
      propertyId,
      bookingId,
      source,
      guestName: String(guestName || "").slice(0, 200),
      rating: Number.isFinite(raw) ? Math.min(10, Math.max(1, raw)) : stars,
      stars,
      title: String(title || "").slice(0, 500),
      text: String(text || "").slice(0, 8000),
      language: String(language || "").slice(0, 16),
      reviewedAt: reviewedAt ? new Date(reviewedAt) : new Date(),
      sentiment: sentimentFor(stars),
    };

    // Idempotent when the source gave us a stable id; plain insert otherwise.
    if (externalId) {
      const review = await Review.findOneAndUpdate(
        { externalId: String(externalId) },
        { $set: doc, $setOnInsert: { externalId: String(externalId) } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return { ok: true, review };
    }

    const review = await Review.create(doc);
    logger.info(
      `[review] ingested ws=${workspaceId} source=${source} stars=${stars}`,
    );
    return { ok: true, review };
  } catch (e) {
    logger.warn("[review] ingest failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/**
 * Draft a reply with the AI. Saved to reply.draft / reply.status="drafted" —
 * the owner still has to approve it before it goes anywhere.
 *
 * @returns {Promise<{ok, review?, draft?, reason?}>}
 */
async function draftReply(review) {
  try {
    const doc =
      review && review._id ? review : await Review.findById(review).exec();
    if (!doc) return { ok: false, reason: "not_found" };

    const property = doc.propertyId
      ? await Property.findById(doc.propertyId).lean()
      : null;
    const hotelName = property?.name || "the hotel";

    const system = [
      "You write review replies for a hotel. Rules:",
      "- 2–4 sentences. Short, warm, human. Never corporate, never templated.",
      "- Thank them by first name when you have it.",
      "- If they raised a problem, acknowledge it plainly and say what you'll do. Never make excuses, never argue.",
      "- No emoji spam (one at most). No hashtags. No marketing slogans.",
      `- Write in the SAME LANGUAGE as the review${doc.language ? ` (${doc.language})` : ""}.`,
      `- Sign off as ${hotelName}.`,
      "Return ONLY the reply text.",
    ].join("\n");

    const user = [
      `Hotel: ${hotelName}`,
      `Guest: ${doc.guestName || "a guest"}`,
      `Rating: ${doc.stars}/5`,
      doc.title ? `Title: ${doc.title}` : "",
      `Review: ${doc.text || "(no text — rating only)"}`,
    ]
      .filter(Boolean)
      .join("\n");

    const { complete } = require("../ai");
    const draft = await complete({ system, user, maxTokens: 300 });
    if (!draft) return { ok: false, reason: "ai_unavailable" };

    doc.reply.draft = draft;
    doc.reply.status = "drafted";
    await doc.save();
    return { ok: true, review: doc, draft };
  } catch (e) {
    logger.warn("[review] draft failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/** Owner approves the draft (optionally editing the text first). */
async function approveReply(id, text) {
  try {
    const review = await Review.findById(id);
    if (!review) return { ok: false, reason: "not_found" };
    if (text != null) review.reply.draft = String(text).slice(0, 4000);
    if (!review.reply.draft) return { ok: false, reason: "no_draft" };
    review.reply.status = "approved";
    review.reply.approvedAt = new Date();
    await review.save();
    return { ok: true, review };
  } catch (e) {
    logger.warn("[review] approve failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/** Owner decides this one doesn't need a reply. */
async function skipReply(id) {
  try {
    const review = await Review.findById(id);
    if (!review) return { ok: false, reason: "not_found" };
    review.reply.status = "skipped";
    await review.save();
    return { ok: true, review };
  } catch (e) {
    logger.warn("[review] skip failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/**
 * Ask a checked-out guest for feedback — ONCE, and only for guests who came
 * through our own channels. Marks the booking so it can never be sent twice.
 *
 * @returns {Promise<{ok, reason?}>}
 */
async function requestReview({ booking }) {
  try {
    if (!booking?._id) return { ok: false, reason: "missing_booking" };
    if (!DIRECT_SOURCES.includes(booking.source))
      return { ok: false, reason: "ota_source" };
    if (booking.reviewRequestedAt) return { ok: false, reason: "already_sent" };
    if (!booking.contactId || !booking.conversationId)
      return { ok: false, reason: "no_conversation" };

    const Workspace = require("../../models/Workspace");
    const workspace = await Workspace.findById(booking.workspaceId);
    const conversation = await Conversation.findById(booking.conversationId);
    const contact = await Contact.findById(booking.contactId);
    if (!workspace || !conversation || !contact?.igUserId)
      return { ok: false, reason: "no_conversation" };

    const property = await Property.findById(booking.propertyId).lean();
    const first = (booking.guestName || contact.name || "").split(" ")[0];

    const text =
      `${first ? `Hi ${first}! ` : "Hi! "}Thanks for staying with us at ${property?.name || "our place"} 🙏\n\n` +
      "How was everything? Just reply here — good or bad, we read every message.\n\n" +
      "And if you enjoyed your stay, leaving us a review would mean a lot 💛";

    const {
      resolveSendTransport,
    } = require("../instagram/automationEngine");
    const transport = await resolveSendTransport(workspace, conversation);
    const result = await transport.send(contact.igUserId, text, {
      conversationId: conversation.metadata?.providerConversationId,
    });

    // Mark first-and-only-once regardless of send outcome — a retry loop that
    // spams a guest is worse than one missed request.
    await HotelBooking.updateOne(
      { _id: booking._id },
      { $set: { reviewRequestedAt: new Date() } },
    );

    if (!result?.success) {
      logger.warn(
        `[review] request send failed booking=${booking.code || booking._id} err=${result?.error || "unknown"}`,
      );
      return { ok: false, reason: "send_failed" };
    }
    logger.info(
      `[review] requested booking=${booking.code || booking._id} ch=${transport.channel}`,
    );
    return { ok: true };
  } catch (e) {
    logger.warn("[review] request failed", { err: e.message });
    return { ok: false, reason: "error" };
  }
}

/**
 * What guests keep complaining about. Counts themes on recent negative reviews;
 * if none are tagged yet, extracts them with one AI call and stores them so the
 * next call is free.
 *
 * @returns {Promise<{ok, themes: Array<{theme, count}>, reviewCount}>}
 */
async function summarizeThemes(workspaceId) {
  try {
    const reviews = await Review.find({
      workspaceId,
      sentiment: "negative",
    })
      .sort({ reviewedAt: -1 })
      .limit(20);

    if (!reviews.length) return { ok: true, themes: [], reviewCount: 0 };

    const untagged = reviews.filter((r) => !(r.themes || []).length && r.text);
    if (untagged.length) {
      await extractThemes(untagged);
    }

    const counts = new Map();
    for (const r of reviews) {
      for (const t of r.themes || []) {
        const key = String(t).trim().toLowerCase();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    const themes = [...counts.entries()]
      .map(([theme, count]) => ({ theme, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { ok: true, themes, reviewCount: reviews.length };
  } catch (e) {
    logger.warn("[review] themes failed", { err: e.message });
    return { ok: false, themes: [], reviewCount: 0 };
  }
}

/** One AI call that tags a batch of reviews with 1–3 short themes each. */
async function extractThemes(reviews) {
  try {
    const { complete } = require("../ai");
    const numbered = reviews
      .map((r, i) => `${i + 1}. ${String(r.text || "").slice(0, 400)}`)
      .join("\n");

    const out = await complete({
      system:
        "Tag each hotel review with 1-3 short lowercase complaint themes " +
        '(e.g. "noise", "cleanliness", "wifi", "breakfast", "staff", "check-in").\n' +
        'Return ONLY JSON: [{"i":1,"themes":["noise"]}, ...] — no prose, no code fences.',
      user: numbered,
      maxTokens: 600,
      lite: true,
    });
    if (!out) return;

    const json = out.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return;

    for (const row of parsed) {
      const review = reviews[Number(row?.i) - 1];
      if (!review || !Array.isArray(row.themes)) continue;
      review.themes = row.themes
        .map((t) => String(t).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 3);
      await review.save().catch(() => {});
    }
  } catch (e) {
    logger.warn("[review] theme extraction failed", { err: e.message });
  }
}

module.exports = {
  DIRECT_SOURCES,
  ingestReview,
  draftReply,
  approveReply,
  skipReply,
  requestReview,
  summarizeThemes,
};
