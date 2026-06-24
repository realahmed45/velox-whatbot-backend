/**
 * Botlify — Website knowledge importer.
 *
 * The creator pastes a URL; we fetch the page (plus a few key internal pages
 * like About / FAQ / Shipping), strip the HTML to clean text, then use the AI
 * to distill it into a concise, on-brand "business brief" that the DM bot can
 * use as knowledge. No browser, no headless Chrome — just HTTP + cheerio.
 */
const axios = require("axios");
const cheerio = require("cheerio");
const logger = require("../../utils/logger");
const ai = require("./index");

const MAX_PAGES = 4; // main page + up to 3 internal pages
const PAGE_TIMEOUT = 9000;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap per page
const MAX_RAW_CHARS = 24000; // combined text fed to the AI
const MAX_BRIEF_CHARS = 6000; // stored knowledge per source

const UA =
  "Mozilla/5.0 (compatible; BotlifyBot/1.0; +https://botlify.site)";

// Internal links worth following for business context.
const INTERESTING = /(about|faq|help|pricing|price|plan|shipping|delivery|return|refund|contact|product|service|menu|catalog|policy|hours)/i;

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

const fetchHtml = async (url) => {
  const { data } = await axios.get(url.toString(), {
    timeout: PAGE_TIMEOUT,
    maxContentLength: MAX_BYTES,
    maxRedirects: 5,
    responseType: "text",
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    // Some sites send non-2xx for bots but still return usable HTML.
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : "";
};

/** Strip an HTML doc down to readable text + the page title. */
const extractText = (html) => {
  const $ = cheerio.load(html);
  $(
    "script, style, noscript, svg, iframe, nav, footer, header, form, [aria-hidden=true]",
  ).remove();
  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:site_name"]').attr("content") ||
    "";
  const metaDesc =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const text = [metaDesc, bodyText].filter(Boolean).join(" ");
  return { title, text };
};

/** Collect a few same-domain internal links worth scraping. */
const collectInternalLinks = (html, baseUrl) => {
  const $ = cheerio.load(html);
  const seen = new Set();
  const links = [];
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
    const key = u.origin + u.pathname;
    if (seen.has(key) || key === baseUrl.origin + baseUrl.pathname) return;
    if (!INTERESTING.test(u.pathname)) return;
    seen.add(key);
    links.push(u);
  });
  return links.slice(0, MAX_PAGES - 1);
};

/**
 * Import a website into a distilled knowledge brief.
 * @returns {Promise<{ title, url, content, charCount, pagesScraped }>}
 */
const importWebsite = async (rawUrl) => {
  const root = normalizeUrl(rawUrl);

  let firstHtml;
  try {
    firstHtml = await fetchHtml(root);
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

  // Follow a few key internal pages for richer context.
  const internal = collectInternalLinks(firstHtml, root);
  for (const link of internal) {
    try {
      const html = await fetchHtml(link);
      const { title, text } = extractText(html);
      if (text && text.length > 80) pages.push({ url: link.toString(), title, text });
    } catch {
      /* skip individual page failures */
    }
  }

  if (!pages.length || !pages.some((p) => p.text && p.text.length > 60)) {
    throw new Error(
      "We reached the site but couldn't read any text. Try a different page.",
    );
  }

  const siteTitle = pages[0].title || root.hostname;
  let raw = pages
    .map((p) => `# ${p.title || p.url}\n${p.text}`)
    .join("\n\n")
    .slice(0, MAX_RAW_CHARS);

  // Distill into a clean, factual brief the bot can rely on.
  const brief = await ai.complete({
    system:
      "You turn raw website text into a concise knowledge brief for a customer-support AI. " +
      "Extract only real facts: what the business sells/does, key products & prices, " +
      "shipping/return/booking policies, hours, locations, contact details, and important links. " +
      "Use short bullet points grouped under clear headings. Never invent anything. " +
      "If a detail isn't present, omit it. Keep it under 500 words.",
    user: `Website: ${root.hostname}\n\nRaw content:\n${raw}`,
    maxTokens: 900,
    temperature: 0.2,
  });

  const content = (brief || raw).slice(0, MAX_BRIEF_CHARS).trim();

  return {
    title: siteTitle.slice(0, 120),
    url: root.toString(),
    content,
    charCount: content.length,
    pagesScraped: pages.length,
  };
};

/**
 * Distill arbitrary raw text (from a document) into a knowledge brief.
 */
const distillText = async (rawText, label) => {
  const raw = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RAW_CHARS);
  if (!raw || raw.length < 20) {
    throw new Error("Couldn't read enough text from that file");
  }
  const brief = await ai.complete({
    system:
      "You turn a business document (menu, price list, brochure, policy doc) " +
      "into a concise knowledge brief for a customer-support AI. Extract only real " +
      "facts: products/menu items & prices, packages, policies, hours, contact. " +
      "Use short bullet points under clear headings. Never invent anything. Keep it under 500 words.",
    user: `Document: ${label}\n\nContent:\n${raw}`,
    maxTokens: 900,
    temperature: 0.2,
  });
  const content = (brief || raw).slice(0, MAX_BRIEF_CHARS).trim();
  return { content, charCount: content.length };
};

/**
 * Import a PDF or text document buffer into a distilled knowledge brief.
 * @returns {Promise<{ title, content, charCount }>}
 */
const importDocument = async (buffer, filename = "document", mimetype = "") => {
  let text = "";
  const isPdf = mimetype === "application/pdf" || /\.pdf$/i.test(filename);
  if (isPdf) {
    try {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      text = data.text || "";
    } catch (err) {
      logger.warn("[websiteImporter] pdf parse failed", { error: err.message });
      throw new Error("Couldn't read that PDF. Try exporting it again.");
    }
  } else {
    text = buffer.toString("utf8");
  }
  if (!text.trim()) {
    throw new Error("That file didn't contain any readable text");
  }
  const { content, charCount } = await distillText(text, filename);
  return { title: filename.slice(0, 120), content, charCount };
};

module.exports = { importWebsite, importDocument, distillText, normalizeUrl };
