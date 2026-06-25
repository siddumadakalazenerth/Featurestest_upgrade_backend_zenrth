const mongoose = require('mongoose');
const { getRequiredRoomTypes } = require('../constants');

const listingSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: '' },
    // Checklist used for listing-level missing-photo detection.
    // Defaults to REQUIRED_ROOM_TYPES env var but can be overridden per listing.
    requiredRoomTypes: {
      type: [String],
      default: getRequiredRoomTypes,
    },
    propertyReview: {
      summary: { type: String, default: '' },
      warnings: { type: [String], default: [] },
      suggestions: { type: [String], default: [] },
      duplicateGroups: { type: [[String]], default: [] },
      reviewedAt: { type: Date, default: null },
    },
    listingCopy: {
      headline: { type: String, default: '' },
      description: { type: String, default: '' },
      highlights: { type: [String], default: [] },
      factsToConfirm: { type: [String], default: [] },
      approved: { type: Boolean, default: false },
      generatedAt: { type: Date, default: null },
    },
    publication: {
      status: {
        type: String,
        enum: ['draft', 'ready', 'published'],
        default: 'draft',
        index: true,
      },
      publishedAt: { type: Date, default: null },
      destination: { type: String, default: 'zenrth' },
      externalReference: { type: String, default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Listing', listingSchema);
