const mongoose = require('mongoose');

const assetVersionSchema = new mongoose.Schema(
  {
    listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true, index: true },
    photo: { type: mongoose.Schema.Types.ObjectId, ref: 'Photo', required: true, index: true },
    toolJob: { type: mongoose.Schema.Types.ObjectId, ref: 'ToolJob', default: null, index: true },
    kind: { type: String, enum: ['original', 'generated'], required: true },
    url: { type: String, required: true },
    data: { type: Buffer, default: null },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, default: null },
    selected: { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

assetVersionSchema.index({ photo: 1, selected: 1 });

module.exports = mongoose.model('AssetVersion', assetVersionSchema);
