// Central place for pipeline constants pulled from environment variables,
// with the same fallback defaults used in the master report's worked example.

const DEFAULT_REQUIRED_ROOM_TYPES = [
  'Living Room',
  'Kitchen',
  'Bedroom',
  'Bathroom',
  'Exterior',
];

const ROOM_TYPES = [
  'Living Room',
  'Kitchen',
  'Bedroom',
  'Bathroom',
  'Exterior',
  'Dining Room',
  'Balcony',
  'Hallway',
  'Garage',
  'Other',
];

function getRequiredRoomTypes() {
  const raw = process.env.REQUIRED_ROOM_TYPES;
  if (!raw) return DEFAULT_REQUIRED_ROOM_TYPES;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const PIPELINE = {
  qualityThreshold: Number(process.env.QUALITY_THRESHOLD ?? 5),
  analysisCostInr: Number(process.env.ANALYSIS_COST_INR ?? 0.012),
  analysisCostUsd: Number(process.env.ANALYSIS_COST_USD ?? 0.00015),
  enhancementCostInr: Number(process.env.ENHANCEMENT_COST_INR ?? 2.5),
};

const UPLOAD_LIMITS = {
  maxPhotosPerListing: 5,
  // Vercel's serverless functions reject any request body over 4.5 MB
  // before your code even runs (a platform limit, not configurable). The
  // previous 5 MB total here was already over that ceiling — a perfectly
  // valid 5-photo upload could be rejected by Vercel itself with a generic
  // error instead of this app's friendly message. Lowered to 4 MB total to
  // leave headroom for multipart form overhead.
  maxBytesPerListing: 4 * 1024 * 1024,
  maxBytesPerFile: 4 * 1024 * 1024,
};

module.exports = {
  ROOM_TYPES,
  DEFAULT_REQUIRED_ROOM_TYPES,
  getRequiredRoomTypes,
  PIPELINE,
  UPLOAD_LIMITS,
};
