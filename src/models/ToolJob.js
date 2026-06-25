const mongoose = require('mongoose');

const toolJobSchema = new mongoose.Schema(
  {
    listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true, index: true },
    photo: { type: mongoose.Schema.Types.ObjectId, ref: 'Photo', default: null, index: true },
    actionId: { type: String, required: true },
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
        'virtual_staging_render',
        'custom_edit',
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'ready_for_review', 'accepted', 'rejected', 'failed'],
      default: 'queued',
      index: true,
    },
    prompt: { type: String, default: '' },
    provider: { type: String, default: null },
    sourceUrl: { type: String, default: null },
    resultUrl: { type: String, default: null },
    resultVersion: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetVersion', default: null },
    resultType: { type: String, enum: ['none', 'image', 'report', 'text'], default: 'none' },
    resultData: { type: mongoose.Schema.Types.Mixed, default: null },
    message: { type: String, default: '' },
    errorMessage: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ToolJob', toolJobSchema);
