/**
 * Botlify — Cloudflare Turnstile verification.
 *
 * Confirms a request came from a real browser session (bot/abuse protection)
 * before sensitive auth actions: login, register, password change/reset.
 *
 * The client solves a Turnstile challenge and sends the resulting token as
 * `cf-turnstile-token` (body) or the `CF-Turnstile-Token` header. We verify it
 * server-side against Cloudflare's siteverify endpoint.
 *
 * Fail-open when unconfigured: if TURNSTILE_SECRET_KEY is not set, this is a
 * no-op so the app keeps working before the keys are added in Render. Once the
 * secret is present, verification is enforced.
 */
const asyncHandler = require("express-async-handler");
const logger = require("../utils/logger");

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const verifyTurnstile = asyncHandler(async (req, res, next) => {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  // Not configured yet → skip (fail-open). Turn it on by setting the env var.
  if (!secret) return next();

  const token =
    req.body?.["cf-turnstile-token"] ||
    req.body?.turnstileToken ||
    req.headers["cf-turnstile-token"];

  if (!token) {
    res.status(400);
    throw new Error("Human verification required. Please try again.");
  }

  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);
    // Client IP helps Cloudflare score the challenge.
    const ip =
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip;
    if (ip) params.append("remoteip", ip);

    const resp = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await resp.json();

    if (!data.success) {
      logger.warn("[turnstile] verification failed", {
        codes: data["error-codes"],
      });
      res.status(403);
      throw new Error("Human verification failed. Please try again.");
    }
    return next();
  } catch (err) {
    // Network / Cloudflare outage: don't hard-lock users out of login. Log and
    // allow through — the rate limiter still guards against brute force.
    if (res.statusCode === 403 || res.statusCode === 400) throw err;
    logger.error("[turnstile] verify request errored, allowing through", {
      err: err.message,
    });
    return next();
  }
});

module.exports = { verifyTurnstile };
