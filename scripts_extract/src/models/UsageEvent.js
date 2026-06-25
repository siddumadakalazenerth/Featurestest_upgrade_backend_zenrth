const mongoose = require('mongoose');

const usageEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null, index: true },
    tool: { type: String, required: true },
    units: { type: Number, default: 1 },
    costInr: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    status: { type: String, enum: ['reserved', 'completed', 'failed', 'refunded'], default: 'completed' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UsageEvent', usageEventSchema);
