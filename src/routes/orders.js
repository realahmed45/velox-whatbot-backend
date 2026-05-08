const express = require("express");
const router = express.Router();
const { protect, requireWorkspace } = require("../middleware/auth");
const c = require("../controllers/orderController");

router.use(protect);
router.use(requireWorkspace);

router.get("/stats/summary", c.getOrderStats);
router.route("/").get(c.listOrders).post(c.createOrder);
router.route("/:id").get(c.getOrder).patch(c.updateOrder).delete(c.deleteOrder);
router.post("/:id/message", c.sendOrderMessage);

module.exports = router;
