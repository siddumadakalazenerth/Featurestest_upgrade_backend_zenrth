const mongoose = require('mongoose');

// Fixed single-user identity used for all requests — no login required.
const DEFAULT_USER = {
  _id: new mongoose.Types.ObjectId('000000000000000000000001'),
  name: 'Owner',
  email: 'owner@zenrth.local',
  role: 'admin',
  plan: 'professional',
  monthlyToolLimit: 9999,
  active: true,
};

function requireAuth(req, _res, next) {
  req.user = DEFAULT_USER;
  next();
}

// Role is 'admin' so listing/photo access checks always pass.
function requireListingAccess(_req, _res, next) { next(); }
function requirePhotoAccess(_req, _res, next) { next(); }

module.exports = { requireAuth, requireListingAccess, requirePhotoAccess, DEFAULT_USER };
