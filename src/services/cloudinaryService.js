/**
 * Cloudinary Service — File & Image uploads
 */
const cloudinary = require("../config/cloudinary");
const multer = require("multer");

// Memory-based multer for images (flow builder, workspace logos)
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

// Memory-based multer for documents (PDFs, etc.)
const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and Word documents are allowed"), false);
    }
  },
});

/**
 * Upload a file buffer directly to Cloudinary
 */
const uploadBuffer = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "velox-whatbot", ...options },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      },
    );
    stream.end(buffer);
  });
};

/**
 * Delete a file from Cloudinary by public_id
 */
const deleteFile = async (publicId, resourceType = "image") => {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
};

module.exports = {
  uploadImage,
  uploadDocument,
  uploadBuffer,
  deleteFile,
  cloudinary,
};
