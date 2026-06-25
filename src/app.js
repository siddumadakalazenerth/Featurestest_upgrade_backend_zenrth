const express = require('express');
const cors = require('cors');

const listingRoutes = require('./routes/listingRoutes');
const authRoutes = require('./routes/authRoutes');
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

  // No local static file serving — every photo URL (Photo.url, AssetVersion.url)
  // is now a full public Vercel Blob URL, served directly from Blob/its CDN.
  // There is nothing under this app's own domain to serve images from.

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      blob: {
        // Reports presence only — never the actual values. Use this to
        // confirm a deployment actually has the Blob env vars before
        // testing an upload, since env var changes never apply to a
        // deployment that's already running.
        hasStaticToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
        hasOidcStoreId: Boolean(process.env.BLOB_STORE_ID),
        hasOidcToken: Boolean(process.env.VERCEL_OIDC_TOKEN),
        configured: Boolean(
          process.env.BLOB_READ_WRITE_TOKEN ||
            (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)
        ),
      },
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
