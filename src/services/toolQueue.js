const Listing = require('../models/Listing');
const Photo = require('../models/Photo');
const ToolJob = require('../models/ToolJob');
const UsageEvent = require('../models/UsageEvent');
const Notification = require('../models/Notification');
const {
  runMultiImageReview,
  runContentReview,
  runFloorPlanReview,
  runFurnishingSuggestion,
  runListingCopy,
} = require('./geminiTaskService');
const { runGeminiImageEdit } = require('./geminiImageService');

async function runJob(job) {
  const listing = await Listing.findById(job.listing).lean();
  if (!listing) throw new Error('Listing no longer exists');
  const photos = await Photo.find({ listing: listing._id }).lean();
  const photo = job.photo ? photos.find((item) => String(item._id) === String(job.photo)) : null;

  switch (job.tool) {
    case 'multi_image_analysis':
      return { resultType: 'report', resultData: await runMultiImageReview(listing, photos) };
    case 'content_moderation':
      if (!photo) throw new Error('The source photo no longer exists');
      return { resultType: 'report', resultData: await runContentReview(photo) };
    case 'floor_plan_recognition':
      if (!photo) throw new Error('Choose a floor-plan image before starting recognition');
      return { resultType: 'report', resultData: await runFloorPlanReview(photo) };
    case 'virtual_staging': {
      if (!photo) throw new Error('Choose an empty-room photo before requesting furnishing suggestions');
      // Extract user-specified preferences from the job prompt (built by buildSuggestionPrompt in the UI)
      const userPreferences = {};
      if (job.prompt) {
        const roomMatch = /Room:\s*([^.]+)/i.exec(job.prompt);
        if (roomMatch) userPreferences.roomType = roomMatch[1].trim();
        const colorMatch = /Preferred colors:\s*([^.]+)/i.exec(job.prompt);
        if (colorMatch) userPreferences.colorPalette = colorMatch[1].split(/,\s*/);
      }
      const suggestion = await runFurnishingSuggestion(photo, null, userPreferences);
      // Persist onto the Photo document itself, not just this job's resultData,
      // so the suggestion has its own accept/dismiss lifecycle independent of
      // this one-off job record (mirrors how confirmedFloorPlan works).
      const livePhoto = await Photo.findById(photo._id);
      if (livePhoto) {
        livePhoto.furnishingSuggestion = {
          roomType: userPreferences.roomType || suggestion.roomType || photo.analysis?.roomType || null,
          roomSubtype: suggestion.roomSubtype || livePhoto.roomSubtype || null,
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
        await livePhoto.save();
      }
      return { resultType: 'report', resultData: suggestion };
    }
    case 'listing_copy':
      return { resultType: 'text', resultData: await runListingCopy(listing, photos) };
    case 'photo_enhancement':
    case 'defurnishing':
    case 'smart_editing':
    case 'custom_edit':
    case 'virtual_staging_render': {
      if (!photo) throw new Error('The source photo no longer exists');
      const result = await runGeminiImageEdit(job, photo);
      return {
        resultType: 'image',
        resultUrl: result.url,
        resultVersion: result.version._id,
        resultData: { summary: 'A new image version is ready for comparison with the original.' },
      };
    }
    default:
      throw new Error('This image-editing job requires a configured specialist provider');
  }
}

/**
 * Serverless-safe replacement for the old in-memory tool job queue — same
 * reasoning as photoQueue.js. Each job runs to completion (including the
 * Gemini call, which can be slow for image generation) before this function
 * returns, so every caller in the controllers must `await` it.
 */
async function enqueueToolJobs(ids) {
  for (const id of ids.map(String)) {
    const job = await ToolJob.findById(id);
    if (!job || job.status !== 'queued') continue;
    try {
      job.status = 'processing';
      job.startedAt = new Date();
      job.errorMessage = null;
      job.message = 'Zenrth is processing this task.';
      await job.save();
      const result = await runJob(job);
      job.status = 'ready_for_review';
      job.resultType = result.resultType;
      job.resultData = result.resultData;
      job.resultUrl = result.resultUrl || null;
      job.resultVersion = result.resultVersion || null;
      job.completedAt = new Date();
      job.message = 'Review the result and accept it when you are happy.';
    } catch (error) {
      job.status = 'failed';
      job.errorMessage = error.message;
      job.message = error.message;
      job.completedAt = new Date();
    }
    await job.save();
    await UsageEvent.updateOne(
      { listing: job.listing, tool: job.tool, status: 'reserved' },
      { status: job.status === 'failed' ? 'failed' : 'completed' },
      { sort: { createdAt: -1 } }
    );
    const listing = await Listing.findById(job.listing).select('owner title').lean();
    if (listing?.owner) {
      await Notification.create({
        user: listing.owner,
        listing: listing._id,
        type: job.status === 'failed' ? 'tool_failed' : 'tool_ready',
        title: job.status === 'failed' ? 'A property task needs attention' : 'A property result is ready',
        message:
          job.status === 'failed'
            ? `${job.tool.replaceAll('_', ' ')} failed for ${listing.title}.`
            : `${job.tool.replaceAll('_', ' ')} is ready to review for ${listing.title}.`,
      });
    }
  }
}

/**
 * No-op on serverless — see photoQueue.js's resumePendingPhotos for the same
 * reasoning. Any job left "processing" from an interrupted previous request
 * is reset to "queued" so a future explicit retry can pick it up; nothing
 * resumes automatically since there is no persistent process to do so.
 */
async function resumeQueuedToolJobs() {
  await ToolJob.updateMany({ status: 'processing' }, { status: 'queued' });
}

function getToolQueueStatus() {
  // No real queue exists anymore — every enqueueToolJobs call runs to
  // completion before returning. Kept for /api/health shape compatibility.
  return { waiting: 0, processing: false };
}

module.exports = { enqueueToolJobs, resumeQueuedToolJobs, getToolQueueStatus };
