const Photo = require('../models/Photo');
const { analyzeImage } = require('./geminiService');
const { PIPELINE } = require('../constants');

/**
 * Runs Step 2 + Step 3 of the analysis-first pipeline for a single stored photo:
 * call Gemini, persist the result, then gate it for the (future) enhancement step
 * based on QUALITY_THRESHOLD.
 */
async function runAnalysisForPhoto(photo) {
  try {
    const result = await analyzeImage(photo.data, photo.mimeType);

    photo.status = 'analyzed';
    photo.analysis = {
      assetType: result.assetType,
      roomType: result.roomType,
      qualityScore: result.qualityScore,
      suitable: result.suitable,
      issues: result.issues,
      reasoning: result.reasoning,
      emptyRoom: result.emptyRoom,
      recommendation: result.recommendation,
      floorPlan: result.floorPlan,
      scoreBreakdown: result.scoreBreakdown,
      raw: result.raw,
      analyzedAt: new Date(),
      model: result.model,
      costInr: PIPELINE.analysisCostInr,
      costUsd: PIPELINE.analysisCostUsd,
    };
    photo.enhancementGate =
      result.qualityScore >= PIPELINE.qualityThreshold && result.suitable ? 'approved' : 'skipped';
    photo.errorMessage = null;
  } catch (err) {
    photo.status = 'failed';
    photo.errorMessage = err.message;
    photo.enhancementGate = 'pending';
  }

  await photo.save();
  return photo;
}

async function updatePhotoRanking(listingId) {
  const photos = await Photo.find({ listing: listingId });
  const ranked = photos
    .filter((photo) => photo.status === 'analyzed' && photo.analysis?.suitable)
    .sort((a, b) => {
      const scoreDiff = (b.analysis?.qualityScore || 0) - (a.analysis?.qualityScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const readinessDiff =
        (b.analysis?.scoreBreakdown?.listingReadiness || 0) -
        (a.analysis?.scoreBreakdown?.listingReadiness || 0);
      if (readinessDiff !== 0) return readinessDiff;
      return a.createdAt - b.createdAt;
    });

  const rankById = new Map(ranked.map((photo, index) => [String(photo._id), index + 1]));
  const manualCover = photos.find((photo) => photo.manualCover);
  await Promise.all(
    photos.map((photo) => {
      const rank = rankById.get(String(photo._id)) || null;
      const shouldCover = manualCover ? String(photo._id) === String(manualCover._id) : rank === 1;
      if (photo.coverRank === rank && photo.isCover === shouldCover) {
        return Promise.resolve();
      }
      photo.coverRank = rank;
      photo.isCover = shouldCover;
      return photo.save();
    })
  );
}

/**
 * Listing-level "missing photo detection": derived for free from the room types
 * Gemini has already classified, rather than a separate paid call — matching the
 * report's "Strong classification — cheapest per call" note.
 */
function computeMissingRoomTypes(listing, photos) {
  const detected = new Set(
    photos
      .filter((p) => p.status === 'analyzed' && p.analysis?.suitable)
      .map((p) => p.analysis.roomType)
  );
  return listing.requiredRoomTypes.filter((rt) => !detected.has(rt));
}

/**
 * Cost summary comparing "enhance everything" (baseline) against the
 * analysis-first filter, mirroring the worked example in the master report.
 */
function computeCostSummary(photos) {
  const analyzed = photos.filter((p) => p.status === 'analyzed');
  const approved = analyzed.filter((p) => p.enhancementGate === 'approved');
  const skipped = analyzed.filter((p) => p.enhancementGate === 'skipped');

  const analysisCostInr = analyzed.length * PIPELINE.analysisCostInr;
  const baselineEnhancementCostInr = photos.length * PIPELINE.enhancementCostInr;
  const filteredEnhancementCostInr =
    analysisCostInr + approved.length * PIPELINE.enhancementCostInr;

  const reductionPct =
    baselineEnhancementCostInr > 0
      ? ((baselineEnhancementCostInr - filteredEnhancementCostInr) / baselineEnhancementCostInr) * 100
      : 0;

  return {
    totalPhotos: photos.length,
    analyzedPhotos: analyzed.length,
    approvedForEnhancement: approved.length,
    skippedByQualityGate: skipped.length,
    analysisCostInr: round2(analysisCostInr),
    baselineEnhancementCostInr: round2(baselineEnhancementCostInr),
    filteredEnhancementCostInr: round2(filteredEnhancementCostInr),
    estimatedReductionPct: round2(reductionPct),
    qualityThreshold: PIPELINE.qualityThreshold,
    enhancementCostInr: PIPELINE.enhancementCostInr,
    analysisCostPerImageInr: PIPELINE.analysisCostInr,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  runAnalysisForPhoto,
  updatePhotoRanking,
  computeMissingRoomTypes,
  computeCostSummary,
};
