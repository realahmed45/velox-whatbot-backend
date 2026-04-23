const express = require("express");
const router = express.Router();
const asyncHandler = require("express-async-handler");
const { protect } = require("../middleware/auth");
const {
  uploadImage,
  uploadDocument,
  uploadBuffer,
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

    // Upload buffer to Cloudinary
    const result = await uploadBuffer(req.file.buffer, {
      folder: "scheduled-posts",
      resource_type: "image",
    });

    res.json({
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
      format: result.format,
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

    // Upload buffer to Cloudinary
    const result = await uploadBuffer(req.file.buffer, {
      folder: "documents",
      resource_type: "raw",
    });

    res.json({
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
      fileName: req.file.originalname,
    });
  }),
);

module.exports = router;
