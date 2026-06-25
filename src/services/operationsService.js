const AuditEvent = require('../models/AuditEvent');
const UsageEvent = require('../models/UsageEvent');

async function audit(req, action, entityType, entityId, listing, metadata = {}) {
  return AuditEvent.create({
    user: req.user?._id || null,
    listing: listing || null,
    action,
    entityType,
    entityId: entityId ? String(entityId) : null,
    metadata,
    ip: req.ip,
  });
}

function monthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function getUsage(userId) {
  const events = await UsageEvent.find({
    user: userId,
    createdAt: { $gte: monthStart() },
    status: { $in: ['reserved', 'completed'] },
  }).lean();
  return {
    units: events.reduce((sum, event) => sum + event.units, 0),
    costInr: Math.round(events.reduce((sum, event) => sum + event.costInr, 0) * 100) / 100,
    costUsd: Math.round(events.reduce((sum, event) => sum + event.costUsd, 0) * 10000) / 10000,
  };
}

async function reserveUsage(user, listing, tool, costs = {}) {
  const usage = await getUsage(user._id);
  if (usage.units >= user.monthlyToolLimit) {
    const error = new Error('Monthly AI tool limit reached.');
    error.status = 402;
    throw error;
  }
  return UsageEvent.create({
    user: user._id,
    listing,
    tool,
    units: 1,
    costInr: costs.costInr || 0,
    costUsd: costs.costUsd || 0,
    status: 'reserved',
  });
}

module.exports = { audit, getUsage, reserveUsage };
