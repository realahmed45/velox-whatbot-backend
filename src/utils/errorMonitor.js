/**
 * Botlify — lightweight error monitoring.
 *
 * Forwards captured errors to Sentry using its HTTP "store" endpoint directly,
 * so we get production error tracking WITHOUT adding the @sentry/node SDK (which
 * bloats the bundle and can complicate the Render build). Set SENTRY_DSN to
 * enable; when it's unset this is a no-op beyond structured logging.
 *
 * DSN format: https://<publicKey>@<host>/<projectId>
 *   e.g. https://abc123@o456.ingest.sentry.io/789
 *
 * Also installs process-level guards for unhandledRejection / uncaughtException
 * so a stray async error is logged (and reported) instead of silently crashing.
 */
const logger = require("./logger");

let endpoint = null;
let authHeader = null;
let enabled = false;

function init() {
  const dsn = (process.env.SENTRY_DSN || "").trim();
  if (!dsn) {
    logger.info("[errorMonitor] SENTRY_DSN not set — using local logging only");
    installProcessGuards();
    return;
  }
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\//, "");
    if (!publicKey || !projectId) throw new Error("bad DSN shape");
    endpoint = `${u.protocol}//${u.host}/api/${projectId}/store/`;
    authHeader =
      `Sentry sentry_version=7, sentry_client=botlify/1.0, ` +
      `sentry_key=${publicKey}`;
    enabled = true;
    logger.info("[errorMonitor] Sentry enabled");
  } catch (err) {
    logger.warn(`[errorMonitor] invalid SENTRY_DSN (${err.message}); disabled`);
  }
  installProcessGuards();
}

/**
 * Report an error. `context` is attached as tags/extra (e.g. { route, userId }).
 * Fire-and-forget — never throws, never blocks the request.
 */
function captureError(err, context = {}) {
  const message = err?.message || String(err);
  // Always log locally.
  logger.error(`[capture] ${message}`, { ...context });

  if (!enabled || !endpoint) return;

  const payload = {
    event_id: cryptoRandomHex(),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    logger: "botlify",
    environment: process.env.NODE_ENV || "production",
    tags: pickStrings(context),
    extra: context,
    exception: {
      values: [
        {
          type: err?.name || "Error",
          value: message,
          stacktrace: err?.stack
            ? { frames: parseStack(err.stack) }
            : undefined,
        },
      ],
    },
  };

  // Fire-and-forget POST; swallow all errors (never let monitoring break prod).
  try {
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": authHeader,
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* noop */
  }
}

function installProcessGuards() {
  if (installProcessGuards._done) return;
  installProcessGuards._done = true;
  process.on("unhandledRejection", (reason) => {
    captureError(reason instanceof Error ? reason : new Error(String(reason)), {
      kind: "unhandledRejection",
    });
  });
  process.on("uncaughtException", (err) => {
    captureError(err, { kind: "uncaughtException" });
    // Don't exit — a single bad async path shouldn't take the server down.
  });
}

// ── tiny helpers (no deps) ──────────────────────────────────────────────────
function cryptoRandomHex() {
  return require("crypto").randomBytes(16).toString("hex");
}
function pickStrings(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === "string" || typeof v === "number") out[k] = String(v);
  }
  return out;
}
function parseStack(stack) {
  return String(stack)
    .split("\n")
    .slice(1, 30)
    .map((line) => ({ function: line.trim() }));
}

module.exports = { init, captureError };
