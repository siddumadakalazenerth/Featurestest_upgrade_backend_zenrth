const express = require('express');
const { getPhotoImage, getVersionImage } = require('../controllers/imageController');

const router = express.Router();

// Public-ish, read-only image bytes — no auth header required so plain
// <img src="..."> tags from the frontend can load them directly.
router.get('/photos/:photoId', getPhotoImage);
router.get('/versions/:versionId', getVersionImage);

module.exports = router;
