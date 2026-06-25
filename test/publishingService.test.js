const test = require('node:test');
const assert = require('node:assert/strict');
const { getPublicationChecklist } = require('../src/services/publishingService');

const listing = {
  propertyReview: { reviewedAt: new Date() },
  listingCopy: { approved: true },
};

test('publishing is allowed when required checks are complete', () => {
  const result = getPublicationChecklist(
    listing,
    [{ status: 'analyzed', analysis: { assetType: 'property_photo', issues: [] } }],
    { readiness: 'ready' }
  );
  assert.equal(result.canPublish, true);
});

test('publishing is blocked by unresolved privacy risk', () => {
  const result = getPublicationChecklist(
    listing,
    [
      {
        status: 'analyzed',
        analysis: { assetType: 'property_photo', issues: ['person in frame'] },
        moderation: { status: 'not_reviewed' },
      },
    ],
    { readiness: 'ready' }
  );
  assert.equal(result.canPublish, false);
});
