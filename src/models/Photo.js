const mongoose = require('mongoose');

const photoSchema = new mongoose.Schema(
  {
    listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true, index: true },

    originalName: { type: String, required: true },
    storedFilename: { type: String, required: true },
    data: { type: Buffer, required: true }, // raw image bytes, stored directly in MongoDB
    url: { type: String, required: true }, // API path that streams `data` back, e.g. /api/images/photos/:id
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },

    // Lifecycle: pending -> analyzed | failed
    status: {
      type: String,
      enum: ['pending', 'analyzed', 'failed'],
      default: 'pending',
      index: true,
    },

    // Gemini Flash output (Section 17: room detection, quality scoring, suitability)
    analysis: {
      assetType: {
        type: String,
        enum: ['property_photo', 'floor_plan'],
        default: 'property_photo',
      },
      roomType: { type: String, default: null },
      qualityScore: { type: Number, default: null }, // 0-10
      suitable: { type: Boolean, default: null },
      issues: { type: [String], default: [] },
      reasoning: { type: String, default: '' },
      emptyRoom: { type: Boolean, default: false },
      recommendation: {
        action: {
          type: String,
          enum: [
            'none',
            'reupload',
            'photo_enhancement',
            'defurnishing',
            'smart_editing',
            'content_moderation',
            'virtual_staging',
          ],
          default: 'none',
        },
        sellerSuggestion: { type: String, default: '' },
        editPrompt: { type: String, default: '' },
        preserve: { type: [String], default: [] },
        confidence: { type: Number, default: null },
      },
      floorPlan: {
        rooms: { type: [String], default: [] },
        confidence: { type: Number, default: null },
        notes: { type: String, default: '' },
      },
      scoreBreakdown: {
        lighting: { type: Number, default: null },
        sharpness: { type: Number, default: null },
        composition: { type: Number, default: null },
        cleanliness: { type: Number, default: null },
        listingReadiness: { type: Number, default: null },
      },
      raw: { type: mongoose.Schema.Types.Mixed, default: null },
      analyzedAt: { type: Date, default: null },
      model: { type: String, default: null },
      costInr: { type: Number, default: null },
      costUsd: { type: Number, default: null },
    },

    // Outcome of the quality-threshold gate (Step 3 in the report's pipeline)
    enhancementGate: {
      type: String,
      enum: ['pending', 'approved', 'skipped'],
      default: 'pending',
      index: true,
    },

    errorMessage: { type: String, default: null },
    isCover: { type: Boolean, default: false, index: true },
    coverRank: { type: Number, default: null },
    galleryRank: { type: Number, default: null, index: true },
    manualCover: { type: Boolean, default: false, index: true },
    moderation: {
      status: {
        type: String,
        enum: ['not_reviewed', 'clear', 'needs_action', 'removed'],
        default: 'not_reviewed',
      },
      risks: { type: [String], default: [] },
      recommendedAction: { type: String, default: '' },
      explanation: { type: String, default: '' },
      reviewedAt: { type: Date, default: null },
    },
    confirmedFloorPlan: {
      visibleRoomLabels: { type: [String], default: [] },
      relationships: { type: [mongoose.Schema.Types.Mixed], default: [] },
      uncertainItems: { type: [String], default: [] },
      summary: { type: String, default: '' },
      confirmedAt: { type: Date, default: null },
    },

    // Which AI fix types have been applied and accepted for this photo.
    // Used to prevent the assessment from re-surfacing the same action after
    // an enhancement was already accepted (avoids the re-analysis loop).
    acceptedFixes: { type: [String], default: [] },

    // User-confirmed subtype for an empty room, gathered before generating
    // furnishing suggestions (e.g. "Guest Bedroom", "Home Office").
    roomSubtype: { type: String, default: null },

    // Gemini's furniture suggestion for an empty/sparse room, shown to the
    // seller as text first (no image generated yet). The seller can accept,
    // edit, or dismiss this before any virtual_staging image edit is queued.
    furnishingSuggestion: {
      roomType: { type: String, default: null },
      roomSubtype: { type: String, default: null },
      estimatedDimensions: {
        widthMeters: { type: Number, default: null },
        lengthMeters: { type: Number, default: null },
        areaSqMeters: { type: Number, default: null },
        confidence: { type: Number, default: null }, // 0-1, visual estimate only — never a survey measurement
        basis: { type: String, default: '' }, // short note on how the estimate was derived
      },
      style: { type: String, default: '' }, // e.g. "Modern", "Minimal", "Luxury"
      colorPalette: { type: [String], default: [] }, // 2-3 named colors that tie the room together
      lightingMood: { type: String, default: '' }, // e.g. "warm ambient (2700K)"
      pieces: {
        type: [
          {
            item: { type: String, default: '' }, // e.g. "3-seater sofa"
            placement: { type: String, default: '' }, // e.g. "along the far wall, facing the window"
            reason: { type: String, default: '' },
          },
        ],
        default: [],
      },
      lighting: {
        type: [
          {
            item: { type: String, default: '' }, // e.g. "arc floor lamp"
            placement: { type: String, default: '' }, // e.g. "beside the armchair"
            reason: { type: String, default: '' },
          },
        ],
        default: [],
      },
      windowTreatments: {
        type: { type: String, default: '' },
        color: { type: String, default: '' },
        notes: { type: String, default: '' },
      },
      bedding: {
        bedSize: { type: String, default: '' },         // e.g. "queen"
        sheetColor: { type: String, default: '' },      // e.g. "warm white"
        pillowArrangement: { type: String, default: '' },
        duvet: { type: String, default: '' },           // e.g. "quilted white duvet with navy piping"
      },
      summary: { type: String, default: '' },
      generatedAt: { type: Date, default: null },
      status: {
        type: String,
        enum: ['suggested', 'accepted', 'dismissed'],
        default: 'suggested',
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Photo', photoSchema);
