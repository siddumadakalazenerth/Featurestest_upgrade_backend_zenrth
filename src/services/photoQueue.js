const Photo = require('../models/Photo');
const Listing = require('../models/Listing');
const { runAnalysisForPhoto, updatePhotoRanking } = require('./analysisService');
const { refreshPropertyAssessment } = require('./propertyAssessmentService');

const queue = [];
const queuedIds = new Set();
let processing = false;

async function enqueuePhotos(photoIds) {
  for (const photoId of photoIds.map(String)) {
    if (queuedIds.has(photoId)) continue;
    queuedIds.add(photoId);
    queue.push(photoId);
  }
  // Awaited (rather than fire-and-forget) so the work finishes before a
  // serverless function returns its response and the process is frozen.
  await processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const photoId = queue.shift();
    queuedIds.delete(photoId);
    try {
      const photo = await Photo.findById(photoId);
      if (!photo) continue;
      await runAnalysisForPhoto(photo);
      await updatePhotoRanking(photo.listing);
      const [listing, photos] = await Promise.all([
        Listing.findById(photo.listing).lean(),
        Photo.find({ listing: photo.listing }).lean(),
      ]);
      if (listing) await refreshPropertyAssessment(listing, photos);
    } catch (error) {
      console.error(`[photo-queue] failed for ${photoId}:`, error.message);
    }
  }

  processing = false;
}

async function resumePendingPhotos() {
  const pending = await Photo.find({ status: 'pending' }).sort({ createdAt: 1 }).select('_id').lean();
  await enqueuePhotos(pending.map((photo) => photo._id));
}

function getQueueStatus() {
  return {
    waiting: queue.length,
    processing,
  };
}

module.exports = { enqueuePhotos, resumePendingPhotos, getQueueStatus };
