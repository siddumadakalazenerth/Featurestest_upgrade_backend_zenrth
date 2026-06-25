const express = require('express');
const cors = require('cors');

const listingRoutes = require('./routes/listingRoutes');
const authRoutes = require('./routes/authRoutes');
const imageRoutes = require('./routes/imageRoutes');
const { listingScoped: photoListingScoped, flat: photoFlat } = require('./routes/photoRoutes');
const { errorHandler } = require('./middleware/errorHandler');
const { PIPELINE, UPLOAD_LIMITS } = require('./constants');
const { getQueueStatus } = require('./services/photoQueue');
const { getToolQueueStatus } = require('./services/toolQueue');
const { requireAuth, requireListingAccess, requirePhotoAccess } = require('./middleware/auth');

function createApp() {
  const app = express();

  app.use(
    cors({
      origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    })
  );
  app.use(express.json());

  // All photo/version bytes live in MongoDB now (no disk, no blob storage).
  // /api/images/photos/:photoId and /api/images/versions/:versionId stream
  // them back out.
  app.use('/api/images', imageRoutes);

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      pipeline: PIPELINE,
      uploadLimits: UPLOAD_LIMITS,
      queue: getQueueStatus(),
      toolQueue: getToolQueueStatus(),
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/listings', requireAuth, listingRoutes);
  app.use('/api/listings/:listingId/photos', requireAuth, requireListingAccess, photoListingScoped);
  app.use('/api/photos', requireAuth, requirePhotoAccess, photoFlat);

  app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
