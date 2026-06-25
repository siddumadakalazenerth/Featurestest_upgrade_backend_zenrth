const Photo = require('../models/Photo');
const AssetVersion = require('../models/AssetVersion');

// Images live in MongoDB (Photo.data / AssetVersion.data are Buffers).
// These two routes are the only place that ever turns that Buffer back
// into an HTTP response — there is no blob storage and no disk involved.

async function getPhotoImage(req, res, next) {
  try {
    const photo = await Photo.findById(req.params.photoId).select('data mimeType').lean();
    if (!photo || !photo.data) return res.status(404).json({ error: 'Image not found' });
    res.set('Content-Type', photo.mimeType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=60');
    res.send(Buffer.isBuffer(photo.data) ? photo.data : Buffer.from(photo.data.buffer || photo.data));
  } catch (err) {
    next(err);
  }
}

async function getVersionImage(req, res, next) {
  try {
    const version = await AssetVersion.findById(req.params.versionId).select('data mimeType').lean();
    if (!version || !version.data) return res.status(404).json({ error: 'Image not found' });
    res.set('Content-Type', version.mimeType || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=60');
    res.send(Buffer.isBuffer(version.data) ? version.data : Buffer.from(version.data.buffer || version.data));
  } catch (err) {
    next(err);
  }
}

module.exports = { getPhotoImage, getVersionImage };
