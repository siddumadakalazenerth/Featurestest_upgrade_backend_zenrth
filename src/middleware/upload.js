const multer = require('multer');
const { UPLOAD_LIMITS } = require('../constants');

// Serverless-safe: files are held in memory as Buffers, never written to the
// local filesystem. Vercel's functions get a fresh, read-only-except-/tmp
// filesystem on every invocation, so anything written to disk here would be
// gone before the next request — sometimes before the current one finishes.
// Controllers are responsible for uploading the buffer to Vercel Blob.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const storage = multer.memoryStorage();

function fileFilter(_req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new Error(`Unsupported file type: ${file.mimetype}. Use JPEG, PNG, WEBP, or HEIC.`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: UPLOAD_LIMITS.maxBytesPerFile,
    files: UPLOAD_LIMITS.maxPhotosPerListing,
  },
});

module.exports = { upload };
