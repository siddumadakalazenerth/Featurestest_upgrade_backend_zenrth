const express = require('express');
const {
  createListing,
  listListings,
  getListing,
  deleteListing,
  executeAction,
  executeAllActions,
  listToolJobs,
  reviewToolJob,
  retryToolJob,
  updateListingCopy,
  publishListing,
  getWorkspaceActivity,
  exportListing,
  updateGallery,
} = require('../controllers/listingController');

const router = express.Router();
const { requireListingAccess } = require('../middleware/auth');

router.post('/', createListing);
router.get('/', listListings);
router.get('/workspace/activity', getWorkspaceActivity);
router.use('/:listingId', requireListingAccess);
router.get('/:listingId', getListing);
router.post('/:listingId/actions/:actionId/execute', executeAction);
router.post('/:listingId/actions/fix-all', executeAllActions);
router.get('/:listingId/tool-jobs', listToolJobs);
router.post('/:listingId/tool-jobs/:jobId/review', reviewToolJob);
router.post('/:listingId/tool-jobs/:jobId/retry', retryToolJob);
router.put('/:listingId/listing-copy', updateListingCopy);
router.post('/:listingId/publish', publishListing);
router.get('/:listingId/export', exportListing);
router.put('/:listingId/gallery', updateGallery);
router.delete('/:listingId', deleteListing);

module.exports = router;
