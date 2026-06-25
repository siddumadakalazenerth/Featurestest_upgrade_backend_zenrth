const Photo = require('../models/Photo');

function getPublicationChecklist(listing, photos, assessment) {
  const analyzedPhotos = photos.filter((photo) => photo.status === 'analyzed');
  const floorPlan = analyzedPhotos.find((photo) => photo.analysis?.assetType === 'floor_plan');
  const moderationRequired = analyzedPhotos.filter((photo) => {
    const issues = (photo.analysis?.issues || []).join(' ').toLowerCase();
    return ['person', 'face', 'document', 'number plate', 'watermark', 'private'].some((term) =>
      issues.includes(term)
    );
  });
  const unresolvedModeration = moderationRequired.filter(
    (photo) => photo.moderation?.status !== 'clear'
  );

  const checks = [
    {
      key: 'property_readiness',
      label: 'Essential property photos are ready',
      complete: assessment.readiness === 'ready' || assessment.readiness === 'nearly_ready',
    },
    {
      key: 'photo_set_review',
      label: 'Photo order and cover have been reviewed',
      complete: Boolean(listing.propertyReview?.reviewedAt),
    },
    {
      key: 'listing_copy',
      label: 'Listing copy has been approved',
      complete: Boolean(listing.listingCopy?.approved),
    },
    {
      key: 'moderation',
      label: 'Publication risks have been cleared',
      complete: unresolvedModeration.length === 0,
    },
    {
      key: 'floor_plan',
      label: 'Floor-plan details are confirmed',
      complete: !floorPlan || Boolean(floorPlan.confirmedFloorPlan?.confirmedAt),
      optional: !floorPlan,
    },
  ];

  return {
    canPublish: checks.every((check) => check.complete || check.optional),
    checks,
  };
}

async function applyMultiImageResult(listing, result) {
  const photos = await Photo.find({ listing: listing._id });
  const byId = new Map(photos.map((photo) => [String(photo._id), photo]));
  const order = Array.isArray(result.galleryOrder) ? result.galleryOrder.map(String) : [];

  for (const photo of photos) {
    const index = order.indexOf(String(photo._id));
    photo.galleryRank = index >= 0 ? index + 1 : null;
    photo.manualCover = String(result.coverPhotoId || '') === String(photo._id);
    if (photo.manualCover) photo.isCover = true;
    await photo.save();
  }

  listing.propertyReview = {
    summary: String(result.summary || '').slice(0, 500),
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 20) : [],
    suggestions: Array.isArray(result.suggestions) ? result.suggestions.map(String).slice(0, 20) : [],
    duplicateGroups: Array.isArray(result.duplicateGroups)
      ? result.duplicateGroups.map((group) => (Array.isArray(group) ? group.map(String) : [])).slice(0, 20)
      : [],
    reviewedAt: new Date(),
  };
  await listing.save();
}

async function applyContentReview(job, result) {
  const photo = await Photo.findById(job.photo);
  if (!photo) throw new Error('The reviewed photo no longer exists');
  photo.moderation = {
    status: result.safeToPublish ? 'clear' : 'needs_action',
    risks: Array.isArray(result.risks) ? result.risks.map(String).slice(0, 20) : [],
    recommendedAction: String(result.recommendedAction || '').slice(0, 100),
    explanation: String(result.explanation || '').slice(0, 500),
    reviewedAt: new Date(),
  };
  await photo.save();
}

async function applyFloorPlanReview(job, result) {
  const photo = await Photo.findById(job.photo);
  if (!photo) throw new Error('The floor plan no longer exists');
  photo.confirmedFloorPlan = {
    visibleRoomLabels: Array.isArray(result.visibleRoomLabels)
      ? result.visibleRoomLabels.map(String).slice(0, 40)
      : [],
    relationships: Array.isArray(result.relationships) ? result.relationships.slice(0, 80) : [],
    uncertainItems: Array.isArray(result.uncertainItems)
      ? result.uncertainItems.map(String).slice(0, 30)
      : [],
    summary: String(result.summary || '').slice(0, 500),
    confirmedAt: new Date(),
  };
  await photo.save();
}

async function applyListingCopy(listing, result) {
  listing.listingCopy = {
    headline: String(result.headline || '').slice(0, 160),
    description: String(result.description || '').slice(0, 5000),
    highlights: Array.isArray(result.highlights) ? result.highlights.map(String).slice(0, 20) : [],
    factsToConfirm: Array.isArray(result.factsToConfirm)
      ? result.factsToConfirm.map(String).slice(0, 20)
      : [],
    approved: true,
    generatedAt: new Date(),
  };
  await listing.save();
}

async function deliverListing(listing, photos) {
  const endpoint = process.env.PUBLISH_PROVIDER_URL;
  if (!endpoint) return { destination: 'zenrth', externalReference: null };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.PUBLISH_PROVIDER_API_KEY
        ? { Authorization: `Bearer ${process.env.PUBLISH_PROVIDER_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      property: {
        id: String(listing._id),
        title: listing.title,
        address: listing.address,
        listingCopy: listing.listingCopy,
      },
      photos: photos.map((photo) => ({
        id: String(photo._id),
        url: photo.url,
        roomType: photo.analysis?.roomType,
        isCover: photo.isCover,
        galleryRank: photo.galleryRank,
        aiEdited: photo.url.includes('/generated/'),
      })),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Publishing provider failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const result = await response.json().catch(() => ({}));
  return {
    destination: String(result.destination || 'external'),
    externalReference: result.externalReference ? String(result.externalReference) : null,
  };
}

module.exports = {
  getPublicationChecklist,
  applyMultiImageResult,
  applyContentReview,
  applyFloorPlanReview,
  applyListingCopy,
  deliverListing,
};
