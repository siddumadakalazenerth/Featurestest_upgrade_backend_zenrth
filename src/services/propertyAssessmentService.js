const PropertyAssessment = require('../models/PropertyAssessment');

const TOOL_LABELS = {
  photo_enhancement: 'Enhance photo',
  defurnishing: 'Remove clutter',
  smart_editing: 'Open smart editor',
  multi_image_analysis: 'Review photo set',
  floor_plan_recognition: 'Review floor plan',
  virtual_staging: 'Suggest furniture',
  listing_copy: 'Prepare listing copy',
  content_moderation: 'Review image',
};

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function makeAction({
  key,
  kind,
  tool = 'none',
  priority,
  title,
  message,
  ctaLabel,
  alternateLabel = '',
  roomType = null,
  photoId = null,
  reasonCodes = [],
  qualityScore = null,
  primaryIssue = null,
}) {
  return {
    actionId: [key, photoId || roomType || 'property'].join(':').replace(/\s+/g, '-').toLowerCase(),
    kind,
    tool,
    priority,
    title,
    message,
    ctaLabel,
    alternateLabel,
    roomType,
    photoId,
    reasonCodes,
    qualityScore,
    primaryIssue,
  };
}

function withArticle(label) {
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label.toLowerCase()}`;
}

function recommendForPhoto(photo) {
  if (photo.status !== 'analyzed') return [];

  const roomType = photo.analysis?.roomType || 'property';
  const photoId = photo._id;
  const actions = [];
  const geminiRecommendation = photo.analysis?.recommendation;

  const acceptedFixes = photo.acceptedFixes || [];
  if (geminiRecommendation?.action && geminiRecommendation.action !== 'none' && !acceptedFixes.includes(geminiRecommendation.action)) {
    const suggestion =
      geminiRecommendation.sellerSuggestion ||
      'Zenrth found a specific improvement for this image.';
    const common = {
      roomType,
      photoId,
      reasonCodes: ['gemini_recommendation'],
    };
    if (geminiRecommendation.action === 'reupload') {
      return [
        makeAction({
          ...common,
          key: 'reupload',
          kind: 'reupload',
          priority: 92,
          title: `Retake the ${roomType.toLowerCase()} photo`,
          message: suggestion,
          ctaLabel: 'Upload replacement',
          alternateLabel: 'Keep current photo',
        }),
      ];
    }
    if (geminiRecommendation.action === 'content_moderation') {
      if (photo.moderation?.status === 'clear') return [];
      return [
        makeAction({
          ...common,
          key: 'moderate',
          kind: 'tool',
          tool: 'content_moderation',
          priority: 96,
          title: `Review the ${roomType.toLowerCase()} photo`,
          message: suggestion,
          ctaLabel: TOOL_LABELS.content_moderation,
          alternateLabel: 'Remove photo',
        }),
      ];
    }
    if (geminiRecommendation.action === 'virtual_staging') {
      const existingSuggestion = photo.furnishingSuggestion;
      if (!existingSuggestion?.generatedAt) {
        return [
          makeAction({
            ...common,
            key: 'suggest-furniture',
            kind: 'tool',
            tool: 'virtual_staging',
            priority: 56,
            title: `Get furniture suggestions for the ${roomType.toLowerCase()}`,
            message: suggestion,
            ctaLabel: TOOL_LABELS.virtual_staging,
            alternateLabel: 'Upload a furnished photo instead',
          }),
        ];
      }
      if (existingSuggestion.status === 'suggested') {
        const pieceCount = existingSuggestion.pieces?.length || 0;
        const dimConfidence = existingSuggestion.estimatedDimensions?.confidence ?? 1;
        if (dimConfidence < 0.4) {
          return [
            makeAction({
              ...common,
              key: 'confirm-room-dimensions',
              kind: 'dimensions_input',
              tool: 'virtual_staging',
              priority: 57,
              title: `Confirm the ${roomType.toLowerCase()}'s size for accurate furniture`,
              message: 'We could not estimate this room\'s size confidently from the photo. Enter its width and length so the furniture suggestion fits properly.',
              ctaLabel: 'Enter room size',
              alternateLabel: 'Use the rough estimate anyway',
            }),
          ];
        }
        return [
          makeAction({
            ...common,
            key: 'review-furniture-suggestion',
            kind: 'review',
            tool: 'virtual_staging',
            priority: 58,
            title: `Review the furniture suggestion for the ${roomType.toLowerCase()}`,
            message:
              existingSuggestion.summary ||
              `Zenrth suggested ${pieceCount} furniture piece${pieceCount === 1 ? '' : 's'} for this room.`,
            ctaLabel: 'Review suggestion',
            alternateLabel: 'Upload a furnished photo instead',
          }),
        ];
      }
      // status === 'accepted' or 'dismissed' — nothing further to surface here.
      return [];
    }
    const photoIssues = photo.analysis?.issues || [];
    const obstructionIssue = photoIssues.find((i) => /obstruct|foreground/i.test(i)) || null;
    const toolCopy = {
      photo_enhancement: {
        key: 'enhance',
        priority: 74,
        title: `Improve the ${roomType.toLowerCase()} photo`,
      },
      defurnishing: {
        key: 'defurnish',
        priority: 69,
        title: `Reduce distractions in the ${roomType.toLowerCase()}`,
      },
      smart_editing: {
        key: 'smart-edit',
        priority: 62,
        title: obstructionIssue
          ? `Remove foreground obstruction from the ${roomType.toLowerCase()}`
          : `Apply a precise edit to the ${roomType.toLowerCase()}`,
      },
    }[geminiRecommendation.action];
    if (toolCopy) {
      const isSmartEdit = geminiRecommendation.action === 'smart_editing';
      return [
        makeAction({
          ...common,
          ...toolCopy,
          kind: 'tool',
          tool: geminiRecommendation.action,
          message: isSmartEdit
            ? (photo.analysis?.reasoning || suggestion)
            : suggestion,
          ctaLabel: TOOL_LABELS[geminiRecommendation.action],
          alternateLabel: 'Upload a better photo',
          qualityScore: isSmartEdit ? (photo.analysis?.qualityScore ?? null) : null,
          primaryIssue: isSmartEdit ? (obstructionIssue || photoIssues[0] || null) : null,
        }),
      ];
    }
  }

  // Gemini noted issues but still gave action 'none' (can happen when it judges the photo
  // usable as-is despite minor flaws). Surface an optional smart_editing action so the
  // seller is at least aware and can act on it — lower priority so it doesn't crowd out
  // blocking actions.
  if (
    (!geminiRecommendation?.action || geminiRecommendation.action === 'none') &&
    photo.analysis?.issues?.length > 0
  ) {
    actions.push(
      makeAction({
        key: 'optional-improve',
        kind: 'tool',
        tool: 'smart_editing',
        priority: 40,
        roomType,
        photoId,
        reasonCodes: ['optional_improvement'],
        title: `Optional: refine the ${roomType.toLowerCase()} photo`,
        message: `Minor issue noted: ${photo.analysis.issues.join(', ')}. The photo is usable as-is — this edit is optional.`,
        ctaLabel: TOOL_LABELS.smart_editing,
        alternateLabel: 'Keep current photo',
      })
    );
  }

  return actions;
}

function calculateAssessment(listing, photos) {
  const analyzed = photos.filter((photo) => photo.status === 'analyzed');
  const suitable = analyzed.filter((photo) => photo.analysis?.suitable);
  const detectedRooms = new Set(suitable.map((photo) => photo.analysis?.roomType).filter(Boolean));
  const missingRooms = listing.requiredRoomTypes.filter((room) => !detectedRooms.has(room));
  const bestByRoom = new Map();

  for (const photo of suitable) {
    const room = photo.analysis?.roomType || 'Other';
    const current = bestByRoom.get(room);
    if (!current || (photo.analysis?.qualityScore || 0) > (current.analysis?.qualityScore || 0)) {
      bestByRoom.set(room, photo);
    }
  }

  const coverage = listing.requiredRoomTypes.length
    ? ((listing.requiredRoomTypes.length - missingRooms.length) / listing.requiredRoomTypes.length) * 100
    : 100;
  const bestScores = [...bestByRoom.values()].map((photo) => photo.analysis?.qualityScore || 0);
  const quality = bestScores.length
    ? (bestScores.reduce((sum, score) => sum + score, 0) / bestScores.length) * 10
    : 0;
  const presentationScores = [...bestByRoom.values()].map(
    (photo) => ((photo.analysis?.scoreBreakdown?.cleanliness || 0) + (photo.analysis?.scoreBreakdown?.listingReadiness || 0)) / 4
  );
  const presentation = presentationScores.length
    ? (presentationScores.reduce((sum, value) => sum + value, 0) / presentationScores.length) * 100
    : 0;
  const consistency = analyzed.length > 1 ? clamp(100 - Math.max(0, analyzed.length - suitable.length) * 18) : analyzed.length ? 65 : 0;
  const floorPlanPhoto = analyzed.find((photo) => photo.analysis?.assetType === 'floor_plan');
  const floorPlan = floorPlanPhoto ? 100 : 0;
  const listingInformation = clamp((listing.title ? 60 : 0) + (listing.address ? 40 : 0));
  const heroImage = photos.some((photo) => photo.isCover) ? 100 : 0;

  const internalScore = Math.round(
    coverage * 0.25 +
      quality * 0.25 +
      presentation * 0.15 +
      consistency * 0.1 +
      floorPlan * 0.1 +
      listingInformation * 0.1 +
      heroImage * 0.05
  );

  const actions = [];
  for (const roomType of missingRooms) {
    actions.push(
      makeAction({
        key: 'missing-room',
        kind: 'upload',
        priority: 100,
        title: `Add ${withArticle(roomType)} photo`,
        message: `Take a landscape photo from the doorway with the lights on and the main features visible.`,
        ctaLabel: `Upload ${roomType.toLowerCase()}`,
        roomType,
        reasonCodes: ['missing_room'],
      })
    );
  }

  for (const photo of analyzed) actions.push(...recommendForPhoto(photo));

  if (analyzed.length >= 3 && !listing.propertyReview?.reviewedAt) {
    actions.push(
      makeAction({
        key: 'multi-image',
        kind: 'tool',
        tool: 'multi_image_analysis',
        priority: missingRooms.length ? 35 : 58,
        title: 'Review the complete photo set',
        message: 'Check for duplicate views, inconsistent room labels, gallery order, and the strongest cover image.',
        ctaLabel: TOOL_LABELS.multi_image_analysis,
        reasonCodes: ['property_consistency'],
      })
    );
  }

  if (floorPlanPhoto && !floorPlanPhoto.confirmedFloorPlan?.confirmedAt) {
    actions.push(
      makeAction({
        key: 'review-floor-plan',
        kind: 'tool',
        tool: 'floor_plan_recognition',
        priority: 55,
        title: 'Confirm the floor-plan rooms',
        message: 'Review the visible room labels and confirm anything the plan does not show clearly.',
        ctaLabel: TOOL_LABELS.floor_plan_recognition,
        photoId: floorPlanPhoto._id,
        reasonCodes: ['floor_plan_confirmation'],
      })
    );
  } else if (analyzed.length >= 1) {
    actions.push(
      makeAction({
        key: 'floor-plan',
        kind: 'upload',
        tool: 'floor_plan_recognition',
        priority: 30,
        title: 'Add a floor plan if available',
        message: 'A floor plan helps us check room coverage and connect each room with its best photo.',
        ctaLabel: 'Upload floor plan',
        reasonCodes: ['optional_floor_plan'],
      })
    );
  }

  const blockingActions = actions.filter((action) => action.priority >= 60);
  if (
    analyzed.length &&
    !blockingActions.length &&
    !missingRooms.length &&
    !listing.listingCopy?.approved
  ) {
    actions.push(
      makeAction({
        key: 'listing-copy',
        kind: 'tool',
        tool: 'listing_copy',
        priority: 50,
        title: 'Prepare the property listing',
        message: 'The photo set is ready for property-level review and listing-copy preparation.',
        ctaLabel: TOOL_LABELS.listing_copy,
        reasonCodes: ['ready_for_copy'],
      })
    );
  }

  const readiness =
    internalScore >= 85
      ? 'ready'
      : internalScore >= 70
        ? 'nearly_ready'
        : internalScore >= 50
          ? 'needs_attention'
          : 'incomplete';

  return {
    internalScore,
    readiness,
    categoryScores: {
      coverage: Math.round(coverage),
      quality: Math.round(quality),
      presentation: Math.round(presentation),
      consistency: Math.round(consistency),
      floorPlan: Math.round(floorPlan),
      listingInformation: Math.round(listingInformation),
      heroImage: Math.round(heroImage),
    },
    actions: actions.sort((a, b) => b.priority - a.priority).slice(0, 12),
    assessedAt: new Date(),
  };
}

async function refreshPropertyAssessment(listing, photos) {
  const assessment = calculateAssessment(listing, photos);
  await PropertyAssessment.findOneAndUpdate(
    { listing: listing._id },
    { listing: listing._id, ...assessment },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return assessment;
}

function publicAssessment(assessment) {
  return {
    readiness: assessment.readiness,
    actions: assessment.actions,
    assessedAt: assessment.assessedAt,
  };
}

module.exports = {
  calculateAssessment,
  refreshPropertyAssessment,
  publicAssessment,
};
