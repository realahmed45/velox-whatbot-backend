const asyncHandler = require("express-async-handler");
const cloudinaryService = require("../services/cloudinaryService");
const multer = require("multer");
const path = require("path");

const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/3gpp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const MAX_SIZE = 16 * 1024 * 1024; // 16 MB

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type"));
  },
});

// @POST /api/upload/media — Upload media for flow messages or broadcasts
const uploadMedia = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error("No file provided");
  }

  const folder = `velox/${req.workspace._id}/media`;
  const isImage = req.file.mimetype.startsWith("image/");
  const isVideo = req.file.mimetype.startsWith("video/");
  const resourceType = isImage ? "image" : isVideo ? "video" : "raw";

  const result = await cloudinaryService.uploadBuffer(req.file.buffer, {
    folder,
    resource_type: resourceType,
    public_id: `${Date.now()}-${path.parse(req.file.originalname).name}`,
  });

  res.status(201).json({
    success: true,
    url: result.secure_url,
    publicId: result.public_id,
    format: result.format,
    bytes: result.bytes,
    resourceType,
  });
});

module.exports = { uploadMedia, upload };
