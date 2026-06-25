const mongoose = require('mongoose');

const auditEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null, index: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true },
    entityId: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AuditEvent', auditEventSchema);
