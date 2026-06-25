const Listing = require('../models/Listing');
const Photo = require('../models/Photo');
const PropertyAssessment = require('../models/PropertyAssessment');
const ToolJob = require('../models/ToolJob');
const AssetVersion = require('../models/AssetVersion');
const {
  updatePhotoRanking,
  computeMissingRoomTypes,
  computeCostSummary,
} = require('../services/analysisService');
const {
  calculateAssessment,
  refreshPropertyAssessment,
  publicAssessment,
} = require('../services/propertyAssessmentService');
const { createToolJob, createCustomEditJob, createFurnishingRenderJob, publicToolJob, GEMINI_SUPPORTED_TOOLS } = require('../services/toolOrchestrator');
const { enqueueToolJobs } = require('../services/toolQueue');
const { enqueuePhotos } = require('../services/photoQueue');
const {
  getPublicationChecklist,
  applyMultiImageResult,
  applyContentReview,
  applyFloorPlanReview,
  applyListingCopy,
  deliverListing,
} = require('../services/publishingService');
const AuditEvent = require('../models/AuditEvent');
const UsageEvent = require('../models/UsageEvent');
const { audit, getUsage } = require('../services/operationsService');
const Notification = require('../models/Notification');

function sortPhotosForDisplay(photos) {
  return [...photos].sort((a, b) => {
    if (a.isCover !== b.isCover) return a.isCover ? -1 : 1;
    if (a.galleryRank && b.galleryRank) return a.galleryRank - b.galleryRank;
    if (a.galleryRank) return -1;
    if (b.galleryRank) return 1;
    if (a.coverRank && b.coverRank) return a.coverRank - b.coverRank;
    if (a.coverRank) return -1;
    if (b.coverRank) return 1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

async function createListing(req, res, next) {
  try {
    const { title, address, requiredRoomTypes } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const listing = await Listing.create({
      owner: req.user._id,
      title: title.trim(),
      address: address?.trim() || '',
      ...(Array.isArray(requiredRoomTypes) && requiredRoomTypes.length
        ? { requiredRoomTypes }
        : {}),
    });
    await audit(req, 'listing.created', 'Listing', listing._id, listing._id);
    res.status(201).json(listing);
  } catch (err) {
    next(err);
  }
}

async function listListings(req, res, next) {
  try {
    const listings = await Listing.find(req.user.role === 'admin' ? {} : { owner: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    // Attach a lightweight summary per listing so the dashboard doesn't need N+1 detail calls.
    const summaries = await Promise.all(
      listings.map(async (listing) => {
        const photos = await Photo.find({ listing: listing._id }).lean();
        const assessment = calculateAssessment(listing, photos);
        return {
          ...listing,
          photoCount: photos.length,
          analyzedCount: photos.filter((p) => p.status === 'analyzed').length,
          failedCount: photos.filter((p) => p.status === 'failed').length,
          missingRoomTypes: computeMissingRoomTypes(listing, photos),
          costSummary: computeCostSummary(photos),
          guidance: publicAssessment(assessment),
        };
      })
    );

    res.json(summaries);
  } catch (err) {
    next(err);
  }
}

async function getListing(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId).lean();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    await updatePhotoRanking(listing._id);
    const photos = sortPhotosForDisplay(await Photo.find({ listing: listing._id }).lean());
    const assessment = await refreshPropertyAssessment(listing, photos);
    const jobs = await ToolJob.find({ listing: listing._id }).sort({ createdAt: -1 }).limit(10);
    const publication = getPublicationChecklist(listing, photos, assessment);

    res.json({
      listing,
      photos,
      missingRoomTypes: computeMissingRoomTypes(listing, photos),
      costSummary: computeCostSummary(photos),
      guidance: publicAssessment(assessment),
      toolJobs: jobs.map(publicToolJob),
      publication,
    });
  } catch (err) {
    next(err);
  }
}

async function deleteListing(req, res, next) {
  try {
    const listing = await Listing.findByIdAndDelete(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    await Photo.deleteMany({ listing: listing._id });
    await Promise.all([
      PropertyAssessment.deleteOne({ listing: listing._id }),
      ToolJob.deleteMany({ listing: listing._id }),
      AssetVersion.deleteMany({ listing: listing._id }),
    ]);
    await audit(req, 'listing.deleted', 'Listing', listing._id, listing._id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function executeAction(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const photos = await Photo.find({ listing: listing._id }).lean();
    const assessment = calculateAssessment(listing.toObject(), photos);
    const action = assessment.actions.find((candidate) => candidate.actionId === req.params.actionId);
    if (!action) {
      return res.status(409).json({
        error: 'This recommendation is no longer active. Refresh the property and choose the latest action.',
      });
    }
    if (action.kind === 'upload' || action.kind === 'reupload') {
      return res.status(200).json({
        type: 'upload',
        roomType: action.roomType,
        photoId: action.photoId,
        message: action.message,
      });
    }

    if (action.kind === 'dimensions_input' && action.tool === 'virtual_staging') {
      return res.status(200).json({
        type: 'dimensions_input',
        photoId: action.photoId,
        message: action.message,
      });
    }

    if (action.kind === 'review' && action.tool === 'virtual_staging') {
      // The suggestion already exists on the Photo document — this action is
      // just "show it to the seller," not a new Gemini call. Re-running
      // createToolJob here would queue a duplicate paid analysis.
      const photo = action.photoId
        ? await Photo.findOne({ _id: action.photoId, listing: listing._id }).lean()
        : null;
      if (!photo?.furnishingSuggestion?.generatedAt) {
        return res.status(409).json({
          error: 'This furnishing suggestion is no longer available. Refresh the property and try again.',
        });
      }
      return res.status(200).json({
        type: 'furnishing_suggestion',
        photoId: action.photoId,
        suggestion: photo.furnishingSuggestion,
      });
    }

    const job = await createToolJob({
      listing,
      action,
      prompt: req.body?.prompt,
    });
    await audit(req, 'tool.started', 'ToolJob', job._id, listing._id, { tool: job.tool });
    res.status(202).json({ type: 'tool_job', job: publicToolJob(job) });
  } catch (err) {
    next(err);
  }
}

async function listToolJobs(req, res, next) {
  try {
    const jobs = await ToolJob.find({ listing: req.params.listingId }).sort({ createdAt: -1 });
    res.json(jobs.map(publicToolJob));
  } catch (err) {
    next(err);
  }
}

async function reviewToolJob(req, res, next) {
  try {
    const job = await ToolJob.findOne({
      _id: req.params.jobId,
      listing: req.params.listingId,
    });
    if (!job) return res.status(404).json({ error: 'Tool job not found' });
    if (job.status !== 'ready_for_review') {
      return res.status(409).json({ error: 'This result is not waiting for review.' });
    }

    const decision = req.body?.decision;
    if (!['accept', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be accept or reject' });
    }

    if (decision === 'reject') {
      job.status = 'rejected';
      job.message = 'The result was rejected. The original remains unchanged.';
      await job.save();
      await audit(req, 'tool.rejected', 'ToolJob', job._id, job.listing, { tool: job.tool });
      return res.json(publicToolJob(job));
    }

    if (job.resultType === 'image') {
      const version = job.resultVersion
        ? await AssetVersion.findOne({ _id: job.resultVersion, toolJob: job._id })
        : null;
      const photo = job.photo ? await Photo.findById(job.photo) : null;
      if (!version || !photo || !version.data) {
        return res.status(409).json({ error: 'The generated image preview is not available.' });
      }
      await AssetVersion.updateMany({ photo: photo._id }, { selected: false });
      version.selected = true;
      await version.save();
      // photo.url is left untouched (/api/images/photos/:id) — only the bytes change.
      photo.data = version.data;
      photo.storedFilename = `version-${version._id}`;
      photo.mimeType = version.mimeType;
      photo.sizeBytes = version.sizeBytes || photo.sizeBytes;
      // Track which fix type was applied so assessment won't re-surface the same
      // action after the enhanced version is re-analyzed (prevents the loop).
      if (job.tool && !photo.acceptedFixes.includes(job.tool)) {
        photo.acceptedFixes.push(job.tool);
      }
      photo.status = 'pending';
      photo.enhancementGate = 'pending';
      photo.errorMessage = null;
      await photo.save();
      await enqueuePhotos([photo._id]);
    } else if (job.resultData) {
      const listing = await Listing.findById(job.listing);
      if (!listing) return res.status(404).json({ error: 'Listing not found' });
      if (job.tool === 'multi_image_analysis') {
        await applyMultiImageResult(listing, job.resultData);
      } else if (job.tool === 'content_moderation') {
        await applyContentReview(job, job.resultData);
      } else if (job.tool === 'floor_plan_recognition') {
        await applyFloorPlanReview(job, job.resultData);
      } else if (job.tool === 'listing_copy') {
        await applyListingCopy(listing, job.resultData);
      } else if (job.tool === 'virtual_staging') {
        // Mark the furnishing suggestion as accepted on the photo, then queue
        // the actual staged-image render using the accepted plan as the brief.
        const photo = job.photo ? await Photo.findById(job.photo) : null;
        if (photo?.furnishingSuggestion?.generatedAt) {
          photo.furnishingSuggestion.status = 'accepted';
          await photo.save();
          await createFurnishingRenderJob({ listing, photo });
        }
      }
    }

    job.status = 'accepted';
    job.message =
      job.tool === 'virtual_staging'
        ? 'Plan accepted — generating the staged image now.'
        : job.resultType === 'image'
        ? 'The approved version is being rechecked automatically.'
        : 'The result was accepted.';
    await job.save();
    await audit(req, 'tool.accepted', 'ToolJob', job._id, job.listing, { tool: job.tool });
    res.json(publicToolJob(job));
  } catch (err) {
    next(err);
  }
}

async function updateListingCopy(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const { headline, description, highlights, factsToConfirm, approved } = req.body || {};
    listing.listingCopy = {
      headline: String(headline || '').slice(0, 160),
      description: String(description || '').slice(0, 5000),
      highlights: Array.isArray(highlights) ? highlights.map(String).slice(0, 20) : [],
      factsToConfirm: Array.isArray(factsToConfirm) ? factsToConfirm.map(String).slice(0, 20) : [],
      approved: Boolean(approved),
      generatedAt: listing.listingCopy?.generatedAt || new Date(),
    };
    await listing.save();
    await audit(req, 'listing.copy_updated', 'Listing', listing._id, listing._id, {
      approved: listing.listingCopy.approved,
    });
    res.json(listing);
  } catch (err) {
    next(err);
  }
}

async function publishListing(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const photos = await Photo.find({ listing: listing._id }).lean();
    const assessment = calculateAssessment(listing.toObject(), photos);
    const publication = getPublicationChecklist(listing.toObject(), photos, assessment);
    if (!publication.canPublish) {
      return res.status(409).json({
        error: 'Complete the remaining final-review items before publishing.',
        publication,
      });
    }
    const delivery = await deliverListing(listing.toObject(), photos);
    listing.publication = {
      status: 'published',
      publishedAt: new Date(),
      destination: delivery.destination,
      externalReference: delivery.externalReference,
    };
    await listing.save();
    await audit(req, 'listing.published', 'Listing', listing._id, listing._id);
    res.json({ listing, publication });
  } catch (err) {
    next(err);
  }
}

async function getWorkspaceActivity(req, res, next) {
  try {
    const listingIds = await Listing.find(
      req.user.role === 'admin' ? {} : { owner: req.user._id }
    ).distinct('_id');
    const [events, usage, notifications] = await Promise.all([
      AuditEvent.find({ listing: { $in: listingIds } }).sort({ createdAt: -1 }).limit(100).lean(),
      getUsage(req.user._id),
      Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    res.json({
      usage: { ...usage, limit: req.user.monthlyToolLimit },
      events,
      notifications,
    });
  } catch (err) {
    next(err);
  }
}

async function exportListing(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId).lean();
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const photos = sortPhotosForDisplay(await Photo.find({ listing: listing._id }).lean());
    const manifest = {
      exportedAt: new Date().toISOString(),
      property: {
        title: listing.title,
        address: listing.address,
        publication: listing.publication,
        listingCopy: listing.listingCopy,
      },
      photos: photos.map((photo) => ({
        id: photo._id,
        url: photo.url,
        roomType: photo.analysis?.roomType,
        isCover: photo.isCover,
        galleryRank: photo.galleryRank,
        aiEdited: photo.url.includes('/generated/'),
        moderation: photo.moderation,
      })),
      disclosure: 'AI-assisted analysis and edits should be disclosed according to the destination portal rules.',
    };
    await audit(req, 'listing.exported', 'Listing', listing._id, listing._id);
    res.setHeader('Content-Disposition', `attachment; filename="zenrth-${listing._id}.json"`);
    res.json(manifest);
  } catch (err) {
    next(err);
  }
}

async function updateGallery(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const order = Array.isArray(req.body?.photoIds) ? req.body.photoIds.map(String) : [];
    const coverPhotoId = String(req.body?.coverPhotoId || '');
    const photos = await Photo.find({ listing: listing._id });
    const valid = new Set(photos.map((photo) => String(photo._id)));
    if (order.some((id) => !valid.has(id)) || (coverPhotoId && !valid.has(coverPhotoId))) {
      return res.status(400).json({ error: 'Gallery contains an invalid photo.' });
    }
    await Promise.all(
      photos.map((photo) => {
        const index = order.indexOf(String(photo._id));
        photo.galleryRank = index >= 0 ? index + 1 : null;
        photo.manualCover = coverPhotoId === String(photo._id);
        photo.isCover = photo.manualCover;
        return photo.save();
      })
    );
    await audit(req, 'gallery.updated', 'Listing', listing._id, listing._id);
    res.json(sortPhotosForDisplay(await Photo.find({ listing: listing._id }).lean()));
  } catch (err) {
    next(err);
  }
}

async function retryToolJob(req, res, next) {
  try {
    const job = await ToolJob.findOne({
      _id: req.params.jobId,
      listing: req.params.listingId,
    });
    if (!job) return res.status(404).json({ error: 'Tool job not found' });
    if (!GEMINI_SUPPORTED_TOOLS.includes(job.tool)) {
      return res.status(409).json({ error: 'This tool is not supported by the Gemini workflow.' });
    }
    job.status = 'queued';
    job.errorMessage = null;
    job.resultData = null;
    job.resultType = 'none';
    job.completedAt = null;
    job.message = 'The task has been added back to the workflow.';
    await job.save();
    await enqueueToolJobs([job._id]);
    res.status(202).json(publicToolJob(job));
  } catch (err) {
    next(err);
  }
}

const BATCH_FIX_TOOLS = ['photo_enhancement', 'defurnishing', 'smart_editing'];

/**
 * "Apply all suggested fixes" — queues every currently-recommended per-photo
 * image correction in one click instead of the seller approving each photo
 * one at a time. Each one still lands in the normal ready_for_review queue,
 * so the seller reviews/accepts each result, but only had to say "go" once.
 */
async function executeAllActions(req, res, next) {
  try {
    const listing = await Listing.findById(req.params.listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });

    const photos = await Photo.find({ listing: listing._id }).lean();
    const assessment = calculateAssessment(listing.toObject(), photos);
    const candidates = assessment.actions.filter(
      (action) => action.kind === 'tool' && BATCH_FIX_TOOLS.includes(action.tool)
    );

    if (!candidates.length) {
      return res.status(409).json({ error: 'There are no suggested photo fixes to apply right now.' });
    }

    const started = [];
    const skipped = [];
    for (const action of candidates) {
      try {
        const job = await createToolJob({ listing, action });
        started.push(publicToolJob(job));
      } catch (err) {
        skipped.push({ actionId: action.actionId, error: err.message });
      }
    }
    await audit(req, 'tool.batch_started', 'Listing', listing._id, listing._id, {
      started: started.length,
      skipped: skipped.length,
    });
    res.status(202).json({ started, skipped });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createListing,
  listListings,
  getListing,
  deleteListing,
  executeAction,
  executeAllActions,
  listToolJobs,
  reviewToolJob,
  retryToolJob,
  updateListingCopy,
  publishListing,
  getWorkspaceActivity,
  exportListing,
  updateGallery,
};
