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
  maxBytesPerListing: 5 * 1024 * 1024,
  maxBytesPerFile: 5 * 1024 * 1024,
};

module.exports = {
  ROOM_TYPES,
  DEFAULT_REQUIRED_ROOM_TYPES,
  getRequiredRoomTypes,
  PIPELINE,
  UPLOAD_LIMITS,
};
