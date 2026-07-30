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

// Deep crawl: BFS the whole site (recursing into links found on child pages),
// fetching pages concurrently. Runs in a BACKGROUND job (see the controller),
// so the higher limits + latency don't hit the HTTP request timeout.
const MAX_PAGES = 120; // pages to crawl for a full-site scrape
const CRAWL_CONCURRENCY = 6; // pages fetched in parallel per batch
const MAX_CRAWL_DEPTH = 4; // link-follow depth from the homepage
const PAGE_TIMEOUT = 12000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap per page
const MAX_RAW_CHARS = 400000; // combined text fed to the AI (deep site)
const MAX_BRIEF_CHARS = 48000; // stored knowledge per source (fits schema 50k)

// Use a real browser UA. Some hosts/CDNs serve a richer (pre-rendered) page to
// browsers than to obvious bots, so this alone often turns a near-empty SPA
// fetch into readable content.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

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

// JS-rendering provider (ScrapingBee): runs a real browser and returns fully
// rendered HTML, so client-side SPAs (Vite/React/Next without SSR) become
// readable. Configured via SCRAPINGBEE_API_KEY. Without it, we skip rendering.
const RENDER_API_KEY = process.env.SCRAPINGBEE_API_KEY || "";
const hasRenderProvider = () => !!RENDER_API_KEY;

/**
 * Fetch a page's FULLY JS-RENDERED HTML via ScrapingBee (a real headless
 * browser). Returns the rendered HTML string (run it through extractText), or
 * "" if rendering isn't configured or fails. Falls back internally to the free
 * reader proxy when no ScrapingBee key is set.
 */
const fetchRenderedHtml = async (url) => {
  // Preferred: ScrapingBee full-browser render → complete HTML.
  if (RENDER_API_KEY) {
    try {
      const { data } = await axios.get("https://app.scrapingbee.com/api/v1/", {
        timeout: 40000,
        maxContentLength: MAX_BYTES,
        responseType: "text",
        params: {
          api_key: RENDER_API_KEY,
          url: url.toString(),
          render_js: "true",
          // wait a moment for late-loading SPA content
          wait: "2500",
          block_resources: "false",
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });
      return typeof data === "string" ? data : "";
    } catch (err) {
      logger.warn("[websiteImporter] ScrapingBee render failed", {
        url: url.toString(),
        error: err.response?.status || err.message,
      });
      // fall through to the free proxy
    }
  }
  return "";
};

/**
 * Get JS-rendered TEXT for a URL. Prefers ScrapingBee's rendered HTML (parsed
 * with our extractor); falls back to the free reader proxy. "" on failure.
 */
const fetchRenderedText = async (url) => {
  // 1. ScrapingBee → rendered HTML → extract with cheerio (same as static path).
  const html = await fetchRenderedHtml(url);
  if (html) {
    const { text } = extractText(html);
    if (text && text.length > 40) return text;
  }
  // 2. Free reader proxy fallback (works when it isn't rate-limited/blocked).
  try {
    const proxied = `https://r.jina.ai/${url.toString()}`;
    const { data } = await axios.get(proxied, {
      timeout: 20000,
      maxContentLength: MAX_BYTES,
      responseType: "text",
      headers: { "User-Agent": UA, Accept: "text/plain,*/*" },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const text =
      typeof data === "string" ? data.replace(/\s+\n/g, "\n").trim() : "";
    return text;
  } catch (err) {
    logger.info("[websiteImporter] render fallback failed", {
      url: url.toString(),
      error: err.message,
    });
    return "";
  }
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

/**
 * SPAs (Next/Nuxt/Vite/React) often ship their copy inside an inline JSON
 * bootstrap (e.g. __NEXT_DATA__, __NUXT__, window.__INITIAL_STATE__) even when
 * the visible <body> is nearly empty. Pull human-readable strings out of those
 * blobs so a JS-rendered marketing site still yields real content.
 */
const extractSpaJsonText = ($) => {
  const chunks = [];
  const collectStrings = (val, depth = 0) => {
    if (depth > 8 || chunks.length > 4000) return;
    if (typeof val === "string") {
      const s = val.trim();
      // Keep sentence-like strings; skip ids, urls, css, hashes.
      if (
        s.length >= 12 &&
        s.length <= 600 &&
        /\s/.test(s) &&
        !/^https?:\/\//i.test(s) &&
        !/^[\w-]+\.(js|css|png|jpe?g|svg|woff2?)/i.test(s) &&
        !/^[A-Fa-f0-9]{16,}$/.test(s)
      ) {
        chunks.push(s);
      }
    } else if (Array.isArray(val)) {
      val.forEach((v) => collectStrings(v, depth + 1));
    } else if (val && typeof val === "object") {
      Object.values(val).forEach((v) => collectStrings(v, depth + 1));
    }
  };

  $('script[type="application/json"], script#__NEXT_DATA__').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      collectStrings(JSON.parse(raw));
    } catch {
      /* not valid JSON — ignore */
    }
  });

  // window.__NUXT__ / __INITIAL_STATE__ style bootstraps.
  $("script:not([src])").each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || !/__(NUXT|NEXT|INITIAL_STATE|APOLLO_STATE)__|self\.__next/i.test(raw))
      return;
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return;
    try {
      collectStrings(JSON.parse(m[0]));
    } catch {
      /* best-effort */
    }
  });

  // De-dupe while preserving order.
  return [...new Set(chunks)].join("\n");
};

/** Strip an HTML doc to readable text + the page title + structured facts. */
const extractText = (html) => {
  const $ = cheerio.load(html);

  // Pull SPA-embedded JSON copy BEFORE we strip <script> tags below.
  const spaText = extractSpaJsonText($);

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
    // SPA JSON copy last — it backfills content when the visible body is thin.
    spaText,
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

/**
 * Discover URLs from sitemaps. Follows a sitemap INDEX into its child sitemaps
 * (one level) so we get the full URL set on big sites, not just the index.
 */
const discoverFromSitemap = async (root) => {
  const readLocs = async (sitemapUrl) => {
    try {
      const xml = await fetchText(
        new URL(sitemapUrl),
        "application/xml,text/xml,*/*",
      );
      const isIndex = /<sitemapindex[\s>]/i.test(xml);
      const locs = (xml.match(/<loc>([^<]+)<\/loc>/gi) || []).map((m) =>
        m.replace(/<\/?loc>/gi, "").trim(),
      );
      return { isIndex, locs };
    } catch {
      return { isIndex: false, locs: [] };
    }
  };

  const candidates = [
    `${root.origin}/sitemap.xml`,
    `${root.origin}/sitemap_index.xml`,
    `${root.origin}/sitemap-index.xml`,
  ];
  const pageUrls = new Set();

  for (const c of candidates) {
    const { isIndex, locs } = await readLocs(c);
    if (!locs.length) continue;
    if (isIndex) {
      // Fetch up to a handful of child sitemaps and collect their page URLs.
      const children = locs.slice(0, 20);
      for (const child of children) {
        const { locs: childLocs } = await readLocs(child);
        childLocs.forEach((l) => pageUrls.add(l));
        if (pageUrls.size > 2000) break;
      }
    } else {
      locs.forEach((l) => pageUrls.add(l));
    }
    if (pageUrls.size) break;
  }

  const urls = [];
  for (const loc of pageUrls) {
    try {
      const u = new URL(loc);
      if (u.hostname === root.hostname) urls.push(u);
    } catch {
      /* ignore */
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
const pathKey = (u) => u.origin + u.pathname.replace(/\/$/, "");

/**
 * Fetch + extract a single page. For thin/SPA pages, falls back to the JS
 * render proxy — but only when `allowRender` is set (root + shallow pages), so
 * a deep crawl doesn't fire a slow render on every leaf.
 */
const scrapePage = async (url, { allowRender = false } = {}) => {
  const THIN = 400;
  let html = "";
  try {
    html = await fetchText(url);
  } catch {
    return null;
  }
  const { title, text } = extractText(html);
  let finalText = text;
  if (allowRender && (!finalText || finalText.length < THIN)) {
    const rendered = await fetchRenderedText(url);
    if (rendered && rendered.length > (finalText?.length || 0)) {
      finalText = [finalText, rendered].filter(Boolean).join("\n");
    }
  }
  return { url: url.toString(), title, text: finalText || "", html };
};

/**
 * Import a website into a distilled knowledge brief via a concurrent BFS deep
 * crawl. Seeds from homepage links + the full sitemap, then follows links found
 * on every fetched page up to MAX_CRAWL_DEPTH / MAX_PAGES. Meant to run in a
 * background job (higher limits + latency than an HTTP request allows).
 *
 * @param {string} rawUrl
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 * @returns {Promise<{ title, url, content, charCount, pagesScraped }>}
 */
const importWebsite = async (rawUrl, onProgress) => {
  const root = normalizeUrl(rawUrl);

  const visited = new Set(); // path keys we've queued/fetched
  const pages = []; // { url, title, text }
  let siteTitle = root.hostname;

  // ── Seed the frontier ──────────────────────────────────────────────────
  // Fetch the homepage first (also validates reachability).
  const rootPage = await scrapePage(root, { allowRender: true });
  if (!rootPage) {
    throw new Error(
      "Couldn't reach that site. Check the link is public and try again.",
    );
  }
  visited.add(pathKey(root));
  if (rootPage.text) {
    pages.push({ url: rootPage.url, title: rootPage.title, text: rootPage.text });
    siteTitle = rootPage.title || siteTitle;
  }

  // depth-tagged frontier
  let frontier = [];
  const enqueue = (urls, depth) => {
    for (const u of urls) {
      const k = pathKey(u);
      if (visited.has(k)) continue;
      if (
        /\.(pdf|jpg|jpeg|png|gif|webp|zip|mp4|mp3|svg|css|js|ico|woff2?)$/i.test(
          u.pathname,
        )
      )
        continue;
      visited.add(k);
      frontier.push({ url: u, depth });
    }
  };

  // Homepage links (depth 1) + sitemap URLs (also depth 1, they're top-level).
  enqueue(collectInternalLinks(rootPage.html, root), 1);
  try {
    enqueue(await discoverFromSitemap(root), 1);
  } catch {
    /* no sitemap — fine */
  }

  // ── Concurrent BFS ─────────────────────────────────────────────────────
  while (frontier.length && pages.length < MAX_PAGES) {
    // Take the next batch, respecting the page cap.
    const room = MAX_PAGES - pages.length;
    const batch = frontier.splice(0, Math.min(CRAWL_CONCURRENCY, room));
    const results = await Promise.all(
      batch.map(({ url, depth }) =>
        // Only spend a render-proxy call on shallow pages (depth 1).
        scrapePage(url, { allowRender: depth <= 1 }).then((r) =>
          r ? { ...r, depth } : null,
        ),
      ),
    );
    for (const r of results) {
      if (!r) continue;
      if (r.text && r.text.length > 60) {
        pages.push({ url: r.url, title: r.title, text: r.text });
      }
      // Follow links from this page if we can still go deeper.
      if (r.depth < MAX_CRAWL_DEPTH && pages.length < MAX_PAGES && r.html) {
        try {
          enqueue(collectInternalLinks(r.html, new URL(r.url)), r.depth + 1);
        } catch {
          /* ignore link parse errors */
        }
      }
    }
    if (typeof onProgress === "function") {
      onProgress({ done: pages.length, total: Math.min(MAX_PAGES, pages.length + frontier.length) });
    }
  }

  if (!pages.length || !pages.some((p) => p.text && p.text.length > 40)) {
    throw new Error(
      "We reached the site but couldn't read any text — it may be built entirely in JavaScript. Try uploading a PDF or pasting your info instead.",
    );
  }

  // ── Distil every page into one knowledge brief ─────────────────────────
  const raw = pages
    .map((p) => `# ${p.title || p.url}\n(${p.url})\n${p.text}`)
    .join("\n\n")
    .slice(0, MAX_RAW_CHARS);

  const content = await distillToKnowledge(
    raw,
    `Website: ${root.hostname}`,
    "website",
    true, // bulk crawl → cheaper flash-lite
  );

  return {
    title: siteTitle.slice(0, 120),
    url: root.toString(),
    content,
    charCount: content.length,
    pagesScraped: pages.length,
  };
};

const DISTILL_SYSTEM = (kind) =>
  "You build a COMPREHENSIVE knowledge base for a customer-support AI from raw " +
  `${kind} content. Capture EVERY useful fact — what the business is and does, ` +
  "all products/services with prices, packages/plans, shipping & delivery, returns & " +
  "refunds, booking/appointment info, opening hours, locations, contact details " +
  "(phone, email, address, socials), team, guarantees, FAQs, and important links. " +
  "Organise it under clear markdown headings with bullet points. Be thorough and " +
  "detailed — do NOT over-summarise; it's better to keep more facts than fewer. " +
  "Never invent anything; only include what's present. Skip nav menus, cookie " +
  "notices and boilerplate.";

// One AI request handles roughly this many characters of source safely within
// free-tier per-request/day token limits (~1 token ≈ 4 chars → ~7k tokens in).
const DISTILL_CHUNK_CHARS = 28000;

/**
 * Distill raw extracted text into a thorough, factual knowledge brief.
 *
 * For large inputs (a deep site crawl) this MAP-REDUCES: the text is split into
 * chunks, each distilled separately (so no single request blows the model's
 * token limit), then the chunk briefs are merged — and, if there are several,
 * lightly de-duplicated by a final pass. Always falls back to raw text if the
 * AI is unavailable, so we never store a tiny summary or fail outright.
 */
const distillToKnowledge = async (
  rawText,
  label,
  kind = "document",
  lite = false,
) => {
  const cleaned = String(rawText || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned || cleaned.length < 20) {
    throw new Error("Couldn't read enough text to learn from");
  }

  const distillChunk = async (chunk) => {
    try {
      return await ai.complete({
        system: DISTILL_SYSTEM(kind),
        user: `${label}\n\nRaw content:\n${chunk}`,
        maxTokens: 4000,
        temperature: 0.2,
        lite, // bulk website distillation uses the cheaper flash-lite model
      });
    } catch (err) {
      logger.warn("[websiteImporter] distill chunk failed", {
        err: err.message,
      });
      return ""; // fall back to raw for this chunk
    }
  };

  // Split into chunks on paragraph boundaries.
  const chunks = [];
  for (let i = 0; i < cleaned.length; i += DISTILL_CHUNK_CHARS) {
    chunks.push(cleaned.slice(i, i + DISTILL_CHUNK_CHARS));
  }

  let brief;
  if (chunks.length === 1) {
    brief = await distillChunk(chunks[0]);
  } else {
    // Map: distill each chunk (cap the number of AI calls to stay cheap).
    const MAX_CHUNKS = 16;
    const briefs = [];
    for (const chunk of chunks.slice(0, MAX_CHUNKS)) {
      const b = await distillChunk(chunk);
      briefs.push(b || chunk.slice(0, 4000));
    }
    const combined = briefs.join("\n\n").slice(0, MAX_BRIEF_CHARS);
    // Reduce: one final tidy/de-dup pass if it's not too large.
    if (combined.length <= DISTILL_CHUNK_CHARS) {
      brief =
        (await distillChunk(combined)) || combined;
    } else {
      brief = combined;
    }
  }

  const rawFallback = cleaned.slice(0, MAX_BRIEF_CHARS).trim();

  // If the AI brief is missing or much thinner than the source, keep the raw
  // text too so we don't lose information.
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
 * Extract raw text from a buffer (PDF / Word / image / CSV / plain text).
 * Shared by knowledge import and product bulk-import.
 * @returns {Promise<string>}
 */
const extractTextFromBuffer = async (buffer, filename = "file", mimetype = "") => {
  let text = "";
  if (isImage(mimetype, filename)) {
    const extracted = await ai.completeVision({
      buffer,
      mimetype: mimetype || "image/png",
      instruction:
        "Transcribe ALL visible text exactly (this may be a menu, price list, " +
        "catalog or product photo). List every item and its price. " +
        "Output plain text only.",
      maxTokens: 4000,
    });
    text = extracted || "";
  } else if (isPdf(mimetype, filename)) {
    // 1) Fast path: pdf-parse reads the embedded text layer (works for
    //    "real" text PDFs). Many menus/catalogs are DESIGN PDFs where the text
    //    is baked into images — those yield little/no text here.
    try {
      const pdfParse = require("pdf-parse");
      const data = await pdfParse(buffer);
      text = data.text || "";
    } catch {
      text = "";
    }
    // 2) Vision fallback: if we got too little text, the PDF is image-based —
    //    let Gemini (natively multimodal) read the whole PDF. This is what
    //    makes big designed menus / scanned docs work.
    if (text.replace(/\s/g, "").length < 40) {
      logger.info("[extract] pdf text layer thin — trying vision", {
        textLayerLen: text.length,
        bytes: buffer.length,
      });
      // Let vision errors (e.g. quota) propagate so the caller reports them.
      const visionText = await ai.readPdfWithVision(buffer);
      logger.info("[extract] vision result", {
        visionLen: visionText?.length || 0,
      });
      if (visionText && visionText.trim().length > text.trim().length) {
        text = visionText;
      }
    }
  } else if (isDocx(mimetype, filename)) {
    const mammoth = require("mammoth");
    const out = await mammoth.extractRawText({ buffer });
    text = out.value || "";
  } else {
    text = buffer.toString("utf8"); // csv / txt / md
  }
  return text;
};

/**
 * Import a PDF / Word / text / image document into a knowledge brief.
 * @returns {Promise<{ title, content, charCount }>}
 */
const importDocument = async (buffer, filename = "document", mimetype = "") => {
  // Use the shared extractor — it already handles the vision fallback for
  // image-based PDFs, designed menus, scanned docs, images, docx, csv, txt.
  let text = "";
  let extractErr = null;
  try {
    text = await extractTextFromBuffer(buffer, filename, mimetype);
  } catch (err) {
    extractErr = err.message;
    logger.warn("[websiteImporter] extract failed", {
      error: err.message,
      filename,
      mimetype,
      bytes: buffer?.length,
    });
    text = "";
  }

  logger.info("[websiteImporter] importDocument", {
    filename,
    mimetype,
    bytes: buffer?.length,
    textLen: text?.length || 0,
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    extractErr,
  });

  if (!text.trim()) {
    // Surface the real cause so it's diagnosable instead of a vague message.
    if (!process.env.GEMINI_API_KEY && isPdf(mimetype, filename)) {
      throw new Error(
        "This looks like an image-based PDF. Reading it needs GEMINI_API_KEY, which isn't configured on the server.",
      );
    }
    const isQuota = /quota|429|rate.?limit/i.test(extractErr || "");
    if (isQuota) {
      throw new Error(
        "The AI is temporarily over its usage limit and couldn't read this file. Please try again in a minute — if it keeps happening, the AI plan needs upgrading.",
      );
    }
    throw new Error(
      "Couldn't read any text from that file. If it's a scanned or image-only PDF, try a clearer copy.",
    );
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
  extractTextFromBuffer,
  distillText,
  distillToKnowledge,
  normalizeUrl,
};
