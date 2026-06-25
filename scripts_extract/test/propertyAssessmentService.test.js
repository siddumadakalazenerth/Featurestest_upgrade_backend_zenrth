const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateAssessment } = require('../src/services/propertyAssessmentService');

const listing = {
  _id: 'listing-1',
  title: 'Test property',
  address: 'Test address',
  requiredRoomTypes: ['Living Room'],
  propertyReview: {},
  listingCopy: {},
};

test('image tool routing uses Gemini recommendation and seller guidance', () => {
  const result = calculateAssessment(listing, [
    {
      _id: 'photo-1',
      status: 'analyzed',
      isCover: true,
      analysis: {
        assetType: 'property_photo',
        roomType: 'Living Room',
        qualityScore: 6,
        suitable: true,
        recommendation: {
          action: 'smart_editing',
          sellerSuggestion: 'Straighten the vertical lines and crop the empty left edge.',
          editPrompt: 'Correct vertical perspective and crop only the empty left edge.',
          preserve: ['windows', 'flooring'],
          confidence: 0.9,
        },
        scoreBreakdown: { cleanliness: 2, listingReadiness: 2 },
      },
    },
  ]);
  const action = result.actions.find((item) => item.tool === 'smart_editing');
  assert.equal(action.message, 'Straighten the vertical lines and crop the empty left edge.');
});

test('backend does not infer an image tool without a Gemini recommendation', () => {
  const result = calculateAssessment(listing, [
    {
      _id: 'photo-1',
      status: 'analyzed',
      isCover: true,
      analysis: {
        assetType: 'property_photo',
        roomType: 'Living Room',
        qualityScore: 3,
        suitable: true,
        issues: ['too dark', 'tilted'],
        scoreBreakdown: { lighting: 0, composition: 0, cleanliness: 2, listingReadiness: 1 },
      },
    },
  ]);
  assert.equal(
    result.actions.some((item) =>
      ['photo_enhancement', 'defurnishing', 'smart_editing'].includes(item.tool)
    ),
    false
  );
});
