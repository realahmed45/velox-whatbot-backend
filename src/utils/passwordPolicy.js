/**
 * Botlify — Password policy.
 * Single source of truth for what counts as a strong password. Used by the
 * register, reset, change, and set-password flows. The frontend mirrors these
 * rules for live feedback, but the backend is the authority.
 */

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "qwerty123",
  "111111111",
  "iloveyou",
  "letmein123",
  "admin123",
  "welcome123",
  "botlify123",
  "instagram",
  "changeme123",
]);

const MIN_LENGTH = 8;

/**
 * Validate a password against the policy.
 * @returns {{ ok: boolean, message?: string, score: number }}
 *   score is 0–4 (weak→strong), for UI meters.
 */
function validatePassword(password, { email, name } = {}) {
  const pw = String(password || "");

  if (pw.length < MIN_LENGTH) {
    return { ok: false, score: 0, message: "Password must be at least 8 characters." };
  }
  if (pw.length > 128) {
    return { ok: false, score: 0, message: "Password is too long (max 128)." };
  }

  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  const hasSymbol = /[^A-Za-z0-9]/.test(pw);

  // Require at least 3 of the 4 character classes.
  const classes = [hasLower, hasUpper, hasNumber, hasSymbol].filter(
    Boolean,
  ).length;
  if (classes < 3) {
    return {
      ok: false,
      score: 1,
      message:
        "Use at least 3 of: lowercase, uppercase, numbers, and symbols.",
    };
  }

  const lower = pw.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return {
      ok: false,
      score: 1,
      message: "That password is too common. Choose something less guessable.",
    };
  }

  // Don't let the password be (or contain) the email local-part or the name.
  const localPart = String(email || "").split("@")[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    return {
      ok: false,
      score: 1,
      message: "Password shouldn't contain your email address.",
    };
  }
  const firstName = String(name || "").trim().split(/\s+/)[0]?.toLowerCase();
  if (firstName && firstName.length >= 4 && lower.includes(firstName)) {
    return {
      ok: false,
      score: 1,
      message: "Password shouldn't contain your name.",
    };
  }

  // Reject long runs of a single repeated character (aaaaaaaa, 11111111).
  if (/(.)\1{5,}/.test(pw)) {
    return {
      ok: false,
      score: 1,
      message: "Password has too many repeated characters.",
    };
  }

  // Score for the meter: length + variety.
  let score = 2;
  if (pw.length >= 12) score += 1;
  if (classes === 4 && pw.length >= 10) score += 1;
  score = Math.min(score, 4);

  return { ok: true, score };
}

module.exports = { validatePassword, MIN_LENGTH };
