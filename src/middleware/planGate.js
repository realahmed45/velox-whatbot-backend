/**
 * Botlify — Plan feature gating middleware
 */
const { planHasFeature } = require("../config/plans");

const requireFeature = (feature) => (req, res, next) => {
  const plan = req.workspace?.subscription?.plan || "starter";
  if (!planHasFeature(plan, feature)) {
    return res.status(403).json({
      error: "upgrade_required",
      feature,
      currentPlan: plan,
      message: `Your current ${plan} plan doesn't include this feature. Please upgrade to unlock it.`,
    });
  }
  next();
};

module.exports = { requireFeature };
