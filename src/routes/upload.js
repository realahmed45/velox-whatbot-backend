const express = require("express");
const router = express.Router();
const asyncHandler = require("express-async-handler");
const { protect } = require("../middleware/auth");
const {
  uploadImage,
  uploadDocument,
} = require("../services/cloudinaryService");

router.use(protect);

// @POST /api/upload/image
router.post(
  "/image",
  uploadImage.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400);
      throw new Error("No image file provided");
    }
    res.json({
      success: true,
      url: req.file.path,
      publicId: req.file.filename,
      format: req.file.mimetype,
    });
  }),
);

// @POST /api/upload/document
router.post(
  "/document",
  uploadDocument.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400);
      throw new Error("No document file provided");
    }
    res.json({
      success: true,
      url: req.file.path,
      publicId: req.file.filename,
      fileName: req.file.originalname,
    });
  }),
);

module.exports = router;
