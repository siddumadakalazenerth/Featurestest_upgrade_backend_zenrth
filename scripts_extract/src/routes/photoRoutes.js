const express = require('express');
const { upload } = require('../middleware/upload');
const {
  uploadPhotos,
  listPhotos,
  reanalyzePhoto,
  replacePhoto,
  deletePhoto,
  reviewFurnishingSuggestion,
  provideFurnishingDimensions,
  verifyCustomFurnishing,
  triggerVirtualStaging,
  customEditPhoto,
  listVersions,
  restoreVersion,
  setRoomSubtype,
} = require('../controllers/photoController');

// Mounted twice from app.js: under /api/listings/:listingId/photos and /api/photos
const listingScoped = express.Router({ mergeParams: true });
listingScoped.post('/', upload.array('photos', 5), uploadPhotos);
listingScoped.get('/', listPhotos);
listingScoped.post('/:photoId/replace', upload.single('photo'), replacePhoto);
listingScoped.post('/:photoId/furnishing-suggestion/review', reviewFurnishingSuggestion);
listingScoped.post('/:photoId/furnishing-suggestion/dimensions', provideFurnishingDimensions);
listingScoped.post('/:photoId/furnishing-suggestion/custom-verify', verifyCustomFurnishing);
listingScoped.post('/:photoId/virtual-staging', triggerVirtualStaging);
listingScoped.post('/:photoId/edit', customEditPhoto);
listingScoped.post('/:photoId/room-subtype', setRoomSubtype);

const flat = express.Router();
flat.post('/:photoId/reanalyze', reanalyzePhoto);
flat.get('/:photoId/versions', listVersions);
flat.post('/:photoId/versions/:versionId/restore', restoreVersion);
flat.delete('/:photoId', deletePhoto);

module.exports = { listingScoped, flat };
