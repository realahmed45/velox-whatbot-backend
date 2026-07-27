/**
 * Botlify — early-bird founding-users program.
 *
 * The first EARLY_BIRD_LIMIT users to sign up get a permanent DISCOUNT_PERCENT
 * off Basic & Pro, for the lifetime of their subscription.
 *
 * The discount itself is applied at Creem checkout via a coupon code that you
 * create in the Creem dashboard (percentage = DISCOUNT_PERCENT, duration =
 * "forever"), then set as CREEM_EARLY_BIRD_CODE in the backend env. Eligibility
 * is decided here at signup (see authController); checkout passes the code only
 * for eligible users.
 */

const EARLY_BIRD_LIMIT = Number(process.env.EARLY_BIRD_LIMIT || 100);
const DISCOUNT_PERCENT = Number(process.env.EARLY_BIRD_PERCENT || 25);

// The Creem discount/coupon code to apply for early-bird users. Create it in
// the Creem dashboard as a "forever" percentage coupon and paste it here.
const CREEM_EARLY_BIRD_CODE = process.env.CREEM_EARLY_BIRD_CODE || "";

module.exports = {
  EARLY_BIRD_LIMIT,
  DISCOUNT_PERCENT,
  CREEM_EARLY_BIRD_CODE,
};
