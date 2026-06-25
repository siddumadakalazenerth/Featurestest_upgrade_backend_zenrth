const multer = require('multer');
const { UPLOAD_LIMITS } = require('../constants');

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

// Images are kept in memory only long enough to be written into MongoDB
// (req.file.buffer / req.files[i].buffer). Nothing touches disk — this is
// required for Vercel's serverless functions, which have a read-only,
// ephemeral filesystem.
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
