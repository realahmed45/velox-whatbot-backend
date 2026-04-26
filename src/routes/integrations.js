const express = require("express");
const router = express.Router();
const {
  protect,
  requireWorkspace,
  requireOwner,
} = require("../middleware/auth");
const c = require("../controllers/webhookIntegrationController");
const ext = require("../controllers/integrationsExtController");

router.use(protect, requireWorkspace);

// Shopify
router.get("/shopify", ext.getShopify);
router.post("/shopify", requireOwner, ext.connectShopify);
router.get("/shopify/products", ext.listShopifyProducts);
router.delete("/shopify", requireOwner, ext.disconnectShopify);

// Mailchimp
router.get("/mailchimp", ext.getMailchimp);
router.post("/mailchimp", requireOwner, ext.connectMailchimp);
router.get("/mailchimp/lists", ext.listMailchimpAudiences);
router.post("/mailchimp/subscribe", ext.mailchimpSubscribe);
router.delete("/mailchimp", requireOwner, ext.disconnectMailchimp);

// Generic webhooks (Zapier/Make/custom)
router.get("/", c.list);
router.post("/", requireOwner, c.create);
router.put("/:id", requireOwner, c.update);
router.delete("/:id", requireOwner, c.remove);
router.post("/:id/test", requireOwner, c.test);

module.exports = router;
