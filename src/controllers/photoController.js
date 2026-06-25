const Listing = require('../models/Listing');
const Photo = require('../models/Photo');
const AssetVersion = require('../models/AssetVersion');
const ToolJob = require('../models/ToolJob');
const { uploadBuffer, deleteByUrl, uniqueFilename } = require('../services/blobStorage');
const {
  updatePhotoRanking,
  computeMissingRoomTypes,
  computeCostSummary,
} = require('../services/analysisService');
const { enqueuePhotos } = require('../services/photoQueue');
const { UPLOAD_LIMITS } = require('../constants');
const { refreshPropertyAssessment } = require('../services/propertyAssessmentService');
const { createCustomEditJob, createVirtualStagingJob, createFurnishingRenderJob, publicToolJob } = require('../services/toolOrchestrator');
const { runFurnishingSuggestion, runFurnishingVerification } = require('../services/geminiTaskService');

function sortPhotosForDisplay(photos) {
  return [...photos].sort((a, b) => {
    if (a.isCover !== b.isCover) return a.isCover ? -1 : 1;
    if (a.coverRank && b.coverRank) return a.coverRank - b.coverRank;
    if (a.coverRank) return -1;
    if (b.coverRank) return 1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

/**
 * Uploads a single Multer in-memory file to Vercel Blob under a per-listing
 * folder, mirroring the old local-disk layout for readability.
 */
async function uploadFileToBlob(listingId, file) {
  const filename = uniqueFilename(file.originalname);
  const pathname = `listings/${listingId}/${filename}`;
  const { url } = await uploadBuffer(file.buffer, pathname, file.mimetype);
  return { url, filename };
}

/**
 * Handles a multi-file upload for a listing. Each photo is saved to disk first
 * (Step 1: "raw original stored at no cost"), then run through Gemini sequentially
 * (Step 2) so a single failure doesn't take down the whole batch.
 */
async function uploadPhotos(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded. Use the "photos" field.' });
    }

    const existingPhotos = await Photo.find({ listing: listing._id }).select('sizeBytes').lean();
    const existingBytes = existingPhotos.reduce((sum, photo) => sum + photo.sizeBytes, 0);
    const incomingBytes = files.reduce((sum, file) => sum + file.size, 0);

    // Nothing has been written anywhere yet at this point — files exist only
    // as in-memory buffers (multer.memoryStorage) until uploadFileToBlob is
    // called below, so these early-exit checks need no cleanup step.
    if (existingPhotos.length + files.length > UPLOAD_LIMITS.maxPhotosPerListing) {
      return res.status(400).json({
        error: `A property can have at most ${UPLOAD_LIMITS.maxPhotosPerListing} photos. ` +
          `It already has ${existingPhotos.length}.`,
      });
    }

    if (existingBytes + incomingBytes > UPLOAD_LIMITS.maxBytesPerListing) {
      return res.status(400).json({
        error: `All photos for one property must total 5 MB or less. ` +
          `Current total is ${(existingBytes / 1024 / 1024).toFixed(2)} MB.`,
      });
    }

    const createdPhotos = [];
    for (const file of files) {
      const { url, filename } = await uploadFileToBlob(listing._id, file);
      const photo = await Photo.create({
        listing: listing._id,
        originalName: file.originalname,
        storedFilename: filename,
        blobUrl: url,
        url,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        status: 'pending',
      });
      createdPhotos.push(photo);
    }

    // Synchronous on Vercel (see photoQueue.js) — this genuinely runs each
    // photo through Gemini before the response is sent. The state fetched
    // below must happen AFTER this, or the response would describe photos
    // that are still "pending" even though the request already waited for
    // them to finish.
    await enqueuePhotos(createdPhotos.map((photo) => photo._id));

    const allPhotos = await Photo.find({ listing: listing._id }).lean();
    const assessment = await refreshPropertyAssessment(listing, allPhotos);
    res.status(200).json({
      uploaded: allPhotos.filter((p) =>
        createdPhotos.some((created) => String(created._id) === String(p._id))
      ),
      queued: createdPhotos.length,
      missingRoomTypes: computeMissingRoomTypes(listing, allPhotos),
      costSummary: computeCostSummary(allPhotos),
      guidance: {
        readiness: assessment.readiness,
        actions: assessment.actions,
        assessedAt: assessment.assessedAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function listPhotos(req, res, next) {
  try {
    const photos = await Photo.find({ listing: req.params.listingId }).lean();
    res.json(sortPhotosForDisplay(photos));
  } catch (err) {
    next(err);
  }
}

async function reanalyzePhoto(req, res, next) {
  try {
    const photo = await Photo.findById(req.params.photoId);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    photo.status = 'pending';
    photo.errorMessage = null;
    photo.enhancementGate = 'pending';
    await photo.save();
    await enqueuePhotos([photo._id]);
    const updated = await Photo.findById(photo._id);
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

async function replacePhoto(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    const photo = await Photo.findOne({ _id: req.params.photoId, listing: listing._id });
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    if (!req.file) return res.status(400).json({ error: 'No replacement image uploaded.' });

    const otherPhotos = await Photo.find({
      listing: listing._id,
      _id: { $ne: photo._id },
    })
      .select('sizeBytes')
      .lean();
    const totalBytes = otherPhotos.reduce((sum, item) => sum + item.sizeBytes, 0) + req.file.size;
    if (totalBytes > UPLOAD_LIMITS.maxBytesPerListing) {
      return res.status(400).json({ error: 'The replacement would exceed the 5 MB property limit.' });
    }

    // Validation passed — only now upload the new file and discard the old one.
    const { url, filename } = await uploadFileToBlob(listing._id, req.file);
    const previousUrl = photo.blobUrl;

    photo.originalName = req.file.originalname;
    photo.storedFilename = filename;
    photo.blobUrl = url;
    photo.url = url;
    photo.mimeType = req.file.mimetype;
    photo.sizeBytes = req.file.size;
    photo.status = 'pending';
    photo.analysis = undefined;
    photo.enhancementGate = 'pending';
    photo.errorMessage = null;
    photo.acceptedFixes = [];
    photo.furnishingSuggestion = undefined;
    photo.roomSubtype = null;
    photo.isCover = false;
    photo.coverRank = null;
    await photo.save();
    await deleteByUrl(previousUrl);
    // Clear old versions and jobs — they reference the previous file which is now deleted.
    await Promise.all([
      AssetVersion.deleteMany({ photo: photo._id }),
      ToolJob.deleteMany({ photo: photo._id }),
    ]);

    await enqueuePhotos([photo._id]);
    const updated = await Photo.findById(photo._id);
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

async function deletePhoto(req, res, next) {
  try {
    const photo = await Photo.findByIdAndDelete(req.params.photoId);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    await deleteByUrl(photo.blobUrl); // best-effort cleanup, mirrors the old disk unlink behavior
    await Promise.all([
      AssetVersion.deleteMany({ photo: photo._id }),
      ToolJob.deleteMany({ photo: photo._id }),
    ]);
    await updatePhotoRanking(photo.listing);
    const [listing, photos] = await Promise.all([
      Listing.findById(photo.listing).lean(),
      Photo.find({ listing: photo.listing }).lean(),
    ]);
    if (listing) await refreshPropertyAssessment(listing, photos);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

/**
 * Seller accepts or dismisses a Gemini furniture suggestion shown as text.
 * Accepting is the seller's one explicit go-ahead — it immediately queues the
 * actual virtual-staging render using the accepted pieces as the brief. The
 * render still lands in the normal ready_for_review queue, so nothing replaces
 * the original photo until the seller separately accepts that result too.
 */
async function reviewFurnishingSuggestion(req, res, next) {
  try {
    const { decision } = req.body || {};
    if (!['accept', 'dismiss'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "accept" or "dismiss"' });
    }
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const photo = await Photo.findOne({ _id: req.params.photoId, listing: listing._id });
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    if (!photo.furnishingSuggestion?.generatedAt) {
      return res.status(409).json({ error: 'No furnishing suggestion exists for this photo yet.' });
    }

    photo.furnishingSuggestion.status = decision === 'accept' ? 'accepted' : 'dismissed';
    await photo.save();

    let job = null;
    if (decision === 'accept') {
      job = await createFurnishingRenderJob({ listing, photo });
    }

    const allPhotos = await Photo.find({ listing: listing._id }).lean();
    await refreshPropertyAssessment(listing.toObject(), allPhotos);

    res.json({ ...photo.toObject(), renderJob: job ? publicToolJob(job) : null });
  } catch (err) {
    next(err);
  }
}

/**
 * Scenario 4/6: the seller clicks any photo, types what they want changed, and
 * gets one preview to approve or ask again — no prompt-writing knowledge needed
 * beyond describing the change in plain language.
 */
async function triggerVirtualStaging(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const photo = await Photo.findOne({ _id: req.params.photoId, listing: listing._id });
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const prompt = String(req.body?.prompt || '').trim() || undefined;
    const job = await createVirtualStagingJob({ listing, photo, prompt });
    res.status(202).json(publicToolJob(job));
  } catch (err) {
    next(err);
  }
}

async function customEditPhoto(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const photo = await Photo.findOne({ _id: req.params.photoId, listing: listing._id });
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Describe the change you want before applying it.' });

    const job = await createCustomEditJob({ listing, photo, prompt });
    res.status(202).json(publicToolJob(job));
  } catch (err) {
    next(err);
  }
}

async function listVersions(req, res, next) {
  try {
    const versions = await AssetVersion.find({ photo: req.params.photoId })
      .sort({ createdAt: -1 })
      .lean();
    res.json(
      versions.map((version) => ({
        _id: version._id,
        kind: version.kind,
        url: version.url,
        mimeType: version.mimeType,
        selected: version.selected,
        metadata: version.metadata,
        createdAt: version.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
}

async function restoreVersion(req, res, next) {
  try {
    const photo = await Photo.findById(req.params.photoId);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const version = await AssetVersion.findOne({
      _id: req.params.versionId,
      photo: photo._id,
    });
    if (!version || !version.blobUrl) return res.status(404).json({ error: 'Version not found' });
    await AssetVersion.updateMany({ photo: photo._id }, { selected: false });
    version.selected = true;
    await version.save();
    photo.url = version.url;
    photo.blobUrl = version.blobUrl;
    photo.storedFilename = version.blobUrl.split('/').pop();
    photo.mimeType = version.mimeType;
    photo.sizeBytes = version.sizeBytes || photo.sizeBytes;
    photo.status = 'pending';
    photo.enhancementGate = 'pending';
    photo.errorMessage = null;
    await photo.save();
    await enqueuePhotos([photo._id]);
    const updated = await Photo.findById(photo._id);
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

/**
 * Scenario 5: when Gemini's own dimension estimate is low-confidence, the seller
 * is asked for two numbers (width/length) instead of getting a guessed suggestion.
 * Regenerates the suggestion using those exact figures so every piece is sized
 * correctly, then leaves it in "suggested" status for the normal accept/dismiss step.
 */
async function provideFurnishingDimensions(req, res, next) {
  try {
    const widthMeters = Number(req.body?.widthMeters);
    const lengthMeters = Number(req.body?.lengthMeters);
    if (!widthMeters || !lengthMeters || widthMeters <= 0 || lengthMeters <= 0) {
      return res.status(400).json({ error: 'Enter the room width and length in meters.' });
    }
    const photo = await Photo.findOne({ _id: req.params.photoId, listing: req.params.listingId });
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const suggestion = await runFurnishingSuggestion(photo, { widthMeters, lengthMeters });
    photo.furnishingSuggestion = {
      roomType: suggestion.roomType || photo.analysis?.roomType || null,
      roomSubtype: suggestion.roomSubtype || photo.roomSubtype || null,
      estimatedDimensions: suggestion.estimatedDimensions || {},
      style: suggestion.style || '',
      colorPalette: Array.isArray(suggestion.colorPalette) ? suggestion.colorPalette.slice(0, 4) : [],
      lightingMood: suggestion.lightingMood || '',
      pieces: Array.isArray(suggestion.pieces) ? suggestion.pieces.slice(0, 6) : [],
      lighting: Array.isArray(suggestion.lighting) ? suggestion.lighting.slice(0, 4) : [],
      windowTreatments: suggestion.windowTreatments || {},
      bedding: suggestion.bedding || {},
      summary: suggestion.summary || '',
      generatedAt: new Date(),
      status: 'suggested',
    };
    await photo.save();
    res.json(photo.toObject());
  } catch (err) {
    next(err);
  }
}

/**
 * Scenario: seller dismissed AI suggestion, describes their own furniture.
 * Gemini checks if it fits the room dimensions. If yes, saves the verified
 * pieces as a new 'suggested' state so the seller can accept/dismiss normally.
 * If no, returns a rejection message without changing the DB.
 */
async function verifyCustomFurnishing(req, res, next) {
  try {
    const customRequest = String(req.body?.request || '').trim();
    if (!customRequest) return res.status(400).json({ error: 'Describe what furniture you want.' });

    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const photo = await Photo.findOne({ _id: req.params.photoId, listing: listing._id });
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const result = await runFurnishingVerification(photo, customRequest);

    if (result.fits && Array.isArray(result.pieces) && result.pieces.length > 0) {
      const existing = photo.furnishingSuggestion || {};
      photo.furnishingSuggestion = {
        roomType: existing.roomType || photo.analysis?.roomType || null,
        roomSubtype: existing.roomSubtype || photo.roomSubtype || null,
        estimatedDimensions: existing.estimatedDimensions || {},
        style: existing.style || '',
        colorPalette: Array.isArray(existing.colorPalette) ? existing.colorPalette : [],
        lightingMood: existing.lightingMood || '',
        pieces: result.pieces.slice(0, 6),
        lighting: Array.isArray(existing.lighting) ? existing.lighting : [],
        windowTreatments: existing.windowTreatments || {},
        bedding: existing.bedding || {},
        summary: result.sellerMessage || result.reason || '',
        generatedAt: new Date(),
        status: 'suggested',
      };
      await photo.save();
      const allPhotos = await Photo.find({ listing: listing._id }).lean();
      await refreshPropertyAssessment(listing.toObject(), allPhotos);
    }

    res.json({ fits: result.fits, message: result.sellerMessage || result.reason });
  } catch (err) {
    next(err);
  }
}

async function setRoomSubtype(req, res, next) {
  try {
    const roomSubtype = String(req.body?.roomSubtype || '').trim();
    const photo = await Photo.findOne({ _id: req.params.photoId, listing: req.params.listingId });
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    photo.roomSubtype = roomSubtype || null;
    await photo.save();
    res.json({ _id: photo._id, roomSubtype: photo.roomSubtype });
  } catch (err) {
    next(err);
  }
}

module.exports = {
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
};
