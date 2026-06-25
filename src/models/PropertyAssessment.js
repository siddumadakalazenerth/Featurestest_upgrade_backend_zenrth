const mongoose = require('mongoose');

const propertyAssessmentSchema = new mongoose.Schema(
  {
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Listing',
      required: true,
      unique: true,
      index: true,
    },
    // Internal automation signal. This value is deliberately never returned by public controllers.
    internalScore: { type: Number, required: true, min: 0, max: 100, select: false },
    readiness: {
      type: String,
      enum: ['incomplete', 'needs_attention', 'nearly_ready', 'ready'],
      required: true,
    },
    categoryScores: {
      coverage: { type: Number, default: 0, select: false },
      quality: { type: Number, default: 0, select: false },
      presentation: { type: Number, default: 0, select: false },
      consistency: { type: Number, default: 0, select: false },
      floorPlan: { type: Number, default: 0, select: false },
      listingInformation: { type: Number, default: 0, select: false },
      heroImage: { type: Number, default: 0, select: false },
    },
    actions: {
      type: [
        {
          actionId: { type: String, required: true },
          kind: {
            type: String,
            enum: ['upload', 'reupload', 'tool', 'review', 'complete'],
            required: true,
          },
          tool: {
            type: String,
            enum: [
              'photo_enhancement',
              'defurnishing',
              'smart_editing',
              'multi_image_analysis',
              'floor_plan_recognition',
              'listing_copy',
              'content_moderation',
              'virtual_staging',
              'none',
            ],
            default: 'none',
          },
          priority: { type: Number, required: true },
          title: { type: String, required: true },
          message: { type: String, required: true },
          ctaLabel: { type: String, required: true },
          alternateLabel: { type: String, default: '' },
          roomType: { type: String, default: null },
          photoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Photo', default: null },
          reasonCodes: { type: [String], default: [] },
          qualityScore: { type: Number, default: null },
          primaryIssue: { type: String, default: null },
        },
      ],
      default: [],
    },
    assessedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PropertyAssessment', propertyAssessmentSchema);
