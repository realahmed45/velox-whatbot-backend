/**
 * Botlify — Knowledge importer (websites, documents, images).
 *
 * Websites: we fetch the homepage, discover more pages via the sitemap and
 * internal links (About / Products / FAQ / Pricing / Shipping / Contact …),
 * strip each page to clean text, pull structured data (JSON-LD) and meta tags,
 * then distill everything into a thorough, factual "business brief" the DM bot
 * can rely on. No headless browser — just HTTP + cheerio.
 *
 * Documents: PDF (pdf-parse), Word .docx (mammoth), plain text / markdown, and
 * images (Groq vision OCR) — any length.
 */
const axios = require("axios");
const cheerio = require("cheerio");
const logger = require("../../utils/logger");
const ai = require("./index");

const MAX_PAGES = 14; // homepage + up to 13 internal pages
const PAGE_TIMEOUT = 12000;
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB cap per page
const MAX_RAW_CHARS = 90000; // combined text fed to the AI
const MAX_BRIEF_CHARS = 14000; // stored knowledge per source

const UA = "Mozilla/5.0 (compatible; BotlifyBot/1.0; +https://botlify.site)";

// Internal links worth following for business context.
const INTERESTING =
  /(about|faq|help|pricing|price|plan|shipping|delivery|return|refund|contact|product|service|menu|catalog|catalogue|policy|hours|team|work|portfolio|case|gallery|shop|store|book|appointment|course|class|feature|solution|industr|support|review|testimonial)/i;

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0)/i;

/** Normalize user input into a valid public http(s) URL or throw. */
const normalizeUrl = (raw) => {
  let s = String(raw || "").trim();
  if (!s) throw new Error("Please enter a website URL");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error("That doesn't look like a valid URL");
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("Only http and https links are supported");
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new Error("That address can't be imported");
  }
  return url;
};

const fetchText = async (url, accept = "text/html,*/*") => {
  const { data } = await axios.get(url.toString(), {
    timeout: PAGE_TIMEOUT,
    maxContentLength: MAX_BYTES,
    maxRedirects: 5,
    responseType: "text",
    headers: { "User-Agent": UA, Accept: accept },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : "";
};

/** Pull readable facts out of JSON-LD structured data blocks. */
const extractJsonLd = ($) => {
  const facts = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const pick = (k) => (node[k] != null ? String(node[k]).trim() : "");
      const bits = [];
      if (pick("@type")) bits.push(pick("@type"));
      if (pick("name")) bits.push(pick("name"));
      if (pick("description")) bits.push(pick("description"));
      if (node.offers) {
        const o = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        if (o?.price)
          bits.push(`Price: ${o.price} ${o.priceCurrency || ""}`.trim());
      }
      if (pick("telephone")) bits.push(`Phone: ${pick("telephone")}`);
      if (pick("email")) bits.push(`Email: ${pick("email")}`);
      if (node.address && typeof node.address === "object") {
        const a = node.address;
        const addr = [
          a.streetAddress,
          a.addressLocality,
          a.addressRegion,
          a.postalCode,
          a.addressCountry,
        ]
          .filter(Boolean)
          .join(", ");
        if (addr) bits.push(`Address: ${addr}`);
      }
      if (bits.length) facts.push(bits.join(" — "));
    }
  });
  return facts.join("\n");
};

/** Strip an HTML doc to readable text + the page title + structured facts. */
const extractText = (html) => {
  const $ = cheerio.load(html);

  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:site_name"]').attr("content") ||
    $('meta[property="og:title"]').attr("content") ||
    "";

  // Meta / open-graph signals (great for JS-rendered sites with thin bodies).
  const metaBits = [];
  const desc =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";
  if (desc) metaBits.push(desc);
  const kw = $('meta[name="keywords"]').attr("content");
  if (kw) metaBits.push(`Keywords: ${kw}`);

  const jsonLd = extractJsonLd($);

  // Remove chrome before reading the body text.
  $(
    "script, style, noscript, svg, iframe, form, [aria-hidden=true], [class*=cookie]",
  ).remove();

  // Headings and list items carry the key facts.
  const headings = [];
  $("h1, h2, h3").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length < 200) headings.push(`## ${t}`);
  });
  const listItems = [];
  $("li").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length > 2 && t.length < 240) listItems.push(`• ${t}`);
  });
  // Image alt text often names products / services.
  const alts = [];
  $("img[alt]").each((_, el) => {
    const a = ($(el).attr("alt") || "").replace(/\s+/g, " ").trim();
    if (a && a.length > 3 && a.length < 160) alts.push(a);
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const text = [
    metaBits.join(" "),
    jsonLd,
    headings.slice(0, 60).join("\n"),
    listItems.slice(0, 120).join("\n"),
    alts.length ? `Images: ${[...new Set(alts)].slice(0, 40).join(", ")}` : "",
    bodyText,
  ]
    .filter(Boolean)
    .join("\n");

  return { title, text };
};

/** Collect same-domain internal links worth scraping (homepage anchors). */
const collectInternalLinks = (html, baseUrl) => {
  const $ = cheerio.load(html);
  const seen = new Set();
  const interesting = [];
  const others = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let u;
    try {
      u = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (u.hostname !== baseUrl.hostname) return;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|zip|mp4|mp3|svg)$/i.test(u.pathname))
      return;
    const key = u.origin + u.pathname;
    if (seen.has(key) || key === baseUrl.origin + baseUrl.pathname) return;
    seen.add(key);
    if (INTERESTING.test(u.pathname)) interesting.push(u);
    else others.push(u);
  });
  // Prefer the "interesting" pages, then fill with the rest.
  return [...interesting, ...others];
};

/** Discover URLs from /sitemap.xml (and a couple of common variants). */
const discoverFromSitemap = async (root) => {
  const candidates = [
    `${root.origin}/sitemap.xml`,
    `${root.origin}/sitemap_index.xml`,
  ];
  const urls = [];
  for (const c of candidates) {
    try {
      const xml = await fetchText(new URL(c), "application/xml,text/xml,*/*");
      const matches = xml.match(/<loc>([^<]+)<\/loc>/gi) || [];
      for (const m of matches) {
        const loc = m.replace(/<\/?loc>/gi, "").trim();
        try {
          const u = new URL(loc);
          if (u.hostname === root.hostname) urls.push(u);
        } catch {
          /* ignore */
        }
      }
      if (urls.length) break;
    } catch {
      /* no sitemap — fine */
    }
  }
  const interesting = urls.filter((u) => INTERESTING.test(u.pathname));
  const rest = urls.filter((u) => !INTERESTING.test(u.pathname));
  return [...interesting, ...rest];
};

const dedupeByPath = (urls) => {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const key = u.origin + u.pathname.replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
};

/**
 * Import a website into a distilled knowledge brief.
 * @returns {Promise<{ title, url, content, charCount, pagesScraped }>}
 */
const importWebsite = async (rawUrl) => {
  const root = normalizeUrl(rawUrl);

  let firstHtml;
  try {
    firstHtml = await fetchText(root);
  } catch (err) {
    logger.warn("[websiteImporter] fetch failed", {
      url: root.toString(),
      error: err.message,
    });
    throw new Error(
      "Couldn't reach that site. Check the link is public and try again.",
    );
  }

  const pages = [];
  const first = extractText(firstHtml);
  if (first.text) pages.push({ url: root.toString(), ...first });

  // Build a crawl queue: internal homepage links + sitemap URLs.
  const fromLinks = collectInternalLinks(firstHtml, root);
  let fromSitemap = [];
  try {
    fromSitemap = await discoverFromSitemap(root);
  } catch {
    /* ignore */
  }
  const queue = dedupeByPath([...fromLinks, ...fromSitemap]).filter(
    (u) => u.origin + u.pathname !== root.origin + root.pathname,
  );

  for (const link of queue) {
    if (pages.length >= MAX_PAGES) break;
    try {
      const html = await fetchText(link);
      const { title, text } = extractText(html);
      if (text && text.length > 60)
        pages.push({ url: link.toString(), title, text });
    } catch {
      /* skip individual page failures */
    }
  }

  if (!pages.length || !pages.some((p) => p.text && p.text.length > 40)) {
    throw new Error(
      "We reached the site but couldn't read any text — it may be built entirely in JavaScript. Try uploading a PDF or pasting your info instead.",
    );
  }

  const siteTitle = pages[0].title || root.hostname;
  const raw = pages
    .map((p) => `# ${p.title || p.url}\n(${p.url})\n${p.text}`)
    .join("\n\n")
    .slice(0, MAX_RAW_CHARS);

  const content = await distillToKnowledge(
    raw,
    `Website: ${root.hostname}`,
    "website",
  );

  return {
    title: siteTitle.slice(0, 120),
    url: root.toString(),
    content,
    charCount: content.length,
    pagesScraped: pages.length,
  };
};

/**
 * Distill raw extracted text into a thorough, factual knowledge brief.
 * Falls back to the cleaned raw text if the AI is unavailable or returns
 * something suspiciously short — so we never store a tiny summary.
 */
const distillToKnowledge = async (rawText, label, kind = "document") => {
  const cleaned = String(rawText || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned || cleaned.length < 20) {
    throw new Error("Couldn't read enough text to learn from");
  }

  const brief = await ai.complete({
    system:
      "You build a COMPREHENSIVE knowledge base for a customer-support AI from raw " +
      `${kind} content. Capture EVERY useful fact — what the business is and does, ` +
      "all products/services with prices, packages/plans, shipping & delivery, returns & " +
      "refunds, booking/appointment info, opening hours, locations, contact details " +
      "(phone, email, address, socials), team, guarantees, FAQs, and important links. " +
      "Organise it under clear markdown headings with bullet points. Be thorough and " +
      "detailed — do NOT over-summarise; it's better to keep more facts than fewer. " +
      "Never invent anything; only include what's present. Skip nav menus, cookie " +
      "notices and boilerplate.",
    user: `${label}\n\nRaw content:\n${cleaned}`,
    maxTokens: 4000,
    temperature: 0.2,
  });

  const rawFallback = cleaned.slice(0, MAX_BRIEF_CHARS).trim();

  // If the AI brief is missing or much thinner than the source, keep the raw
  // text too so we don't lose information (the "250 chars" problem).
  let content;
  if (!brief) {
    content = rawFallback;
  } else if (brief.length < 600 && cleaned.length > 1500) {
    content = `${brief}\n\n---\nSource details:\n${rawFallback}`.slice(
      0,
      MAX_BRIEF_CHARS,
    );
  } else {
    content = brief.slice(0, MAX_BRIEF_CHARS);
  }
  return content.trim();
};

/** Back-compat: distill arbitrary text. */
const distillText = async (rawText, label) => {
  const content = await distillToKnowledge(
    rawText,
    `Document: ${label}`,
    "document",
  );
  return { content, charCount: content.length };
};

const isImage = (mimetype = "", filename = "") =>
  /^image\//i.test(mimetype) ||
  /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(filename);

const isPdf = (mimetype = "", filename = "") =>
  mimetype === "application/pdf" || /\.pdf$/i.test(filename);

const isDocx = (mimetype = "", filename = "") =>
  mimetype ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
  /\.docx$/i.test(filename);

/**
 * Import a PDF / Word / text / image document into a knowledge brief.
 * @returns {Promise<{ title, content, charCount }>}
 */
const importDocument = async (buffer, filename = "document", mimetype = "") => {
  let text = "";

  if (isImage(mimetype, filename)) {
    const extracted = await ai.completeVision({
      buffer,
      mimetype: mimetype || "image/png",
      instruction:
        "This image is from a business (e.g. a menu, price list, flyer, product " +
        "photo, or screenshot). Transcribe ALL visible text exactly, and briefly " +
        "describe products/items and their prices. Output plain text only.",
      maxTokens: 1800,
    });
    if (!extracted || extracted.length < 10) {
      throw new Error(
        "Couldn't read any text or details from that image. Try a clearer photo.",
      );
    }
    text = extracted;
  } else if (isPdf(mimetype, filename)) {
    try {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      text = data.text || "";
    } catch (err) {
      logger.warn("[websiteImporter] pdf parse failed", { error: err.message });
      throw new Error("Couldn't read that PDF. Try exporting it again.");
    }
  } else if (isDocx(mimetype, filename)) {
    try {
      const mammoth = require("mammoth");
      const out = await mammoth.extractRawText({ buffer });
      text = out.value || "";
    } catch (err) {
      logger.warn("[websiteImporter] docx parse failed", {
        error: err.message,
      });
      throw new Error("Couldn't read that Word document.");
    }
  } else {
    text = buffer.toString("utf8");
  }

  if (!text.trim()) {
    throw new Error("That file didn't contain any readable text");
  }

  const content = await distillToKnowledge(
    text,
    `Document: ${filename}`,
    isImage(mimetype, filename) ? "image" : "document",
  );
  return { title: filename.slice(0, 120), content, charCount: content.length };
};

module.exports = {
  importWebsite,
  importDocument,
  distillText,
  distillToKnowledge,
  normalizeUrl,
};
