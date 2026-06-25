const Photo = require('../models/Photo');
const Listing = require('../models/Listing');
const { runAnalysisForPhoto, updatePhotoRanking } = require('./analysisService');
const { refreshPropertyAssessment } = require('./propertyAssessmentService');

/**
 * Serverless-safe replacement for what used to be an in-memory job queue.
 * Vercel functions don't keep a process alive between requests, so a
 * module-level `queue = []` array would reset on every invocation and lose
 * any photo that didn't finish before the function returned. Instead, this
 * runs each photo through Gemini directly, awaited inside the same request
 * that uploaded it — chosen over async/polling because Gemini Flash analysis
 * calls are fast (2-5s) and this app's max batch is 5 small photos.
 *
 * Function names are kept identical to the old queue-based version so
 * every existing call site (uploadPhotos, reanalyzePhoto, replacePhoto,
 * restoreVersion) needed zero changes.
 */
async function enqueuePhotos(photoIds) {
  for (const photoId of photoIds.map(String)) {
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
      // eslint-disable-next-line no-console
      console.error(`[photo-pipeline] failed for ${photoId}:`, error.message);
    }
  }
}

/**
 * No-op on serverless: there is no boot-time moment to "resume" anything —
 * every invocation starts fresh. Kept as a function (rather than deleted)
 * so server.js's startup sequence doesn't need to change. Any photo stuck
 * in "pending" from a previous failed request will be retried the next
 * time the seller hits "reanalyze" or re-uploads.
 */
async function resumePendingPhotos() {
  // Intentionally empty — see comment above.
}

function getQueueStatus() {
  // No real queue exists anymore; every call to enqueuePhotos runs to
  // completion before returning. Kept for API-shape compatibility with
  // the /api/health endpoint.
  return { waiting: 0, processing: false };
}

module.exports = { enqueuePhotos, resumePendingPhotos, getQueueStatus };
