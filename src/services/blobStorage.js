const { put, del } = require('@vercel/blob');

/**
 * Single wrapper around Vercel Blob. Every controller/service that needs to
 * store or remove a file goes through these two functions — nothing else in
 * this codebase should import '@vercel/blob' directly. That keeps the
 * storage provider swappable later (e.g. to S3) by changing only this file.
 *
 * Path convention mirrors the original local-disk layout for readability in
 * the Blob dashboard: listings/{listingId}/{filename} and
 * listings/{listingId}/generated/{filename}.
 */

/**
 * Vercel Blob's SDK can authenticate two different ways, and either one is
 * valid — it does NOT require BLOB_READ_WRITE_TOKEN specifically:
 *
 *   1. OIDC (current default when you click "Connect" on a store from the
 *      dashboard): Vercel injects BLOB_STORE_ID + a short-lived
 *      VERCEL_OIDC_TOKEN that it rotates automatically. The SDK reads both
 *      from process.env with zero code needed — no token argument, nothing.
 *   2. BLOB_READ_WRITE_TOKEN: an older, long-lived static token. Needed for
 *      code that runs OUTSIDE Vercel (e.g. a local script), or for client-
 *      side browser uploads.
 *
 * This function only checks that *one* of those two valid setups exists —
 * it must never hard-require BLOB_READ_WRITE_TOKEN specifically, since a
 * project connected via OIDC will correctly never have that variable at
 * all, and this same check would otherwise reject perfectly valid requests.
 */
function requireToken() {
  const hasStaticToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  const hasOidc = Boolean(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN);

  if (!hasStaticToken && !hasOidc) {
    throw new Error(
      'No Vercel Blob credentials found. Either connect Vercel Blob to this ' +
        'project from the dashboard (Storage → your store → Connect — this ' +
        'auto-injects BLOB_STORE_ID and OIDC, no token needed), or set ' +
        'BLOB_READ_WRITE_TOKEN manually for code running outside Vercel.'
    );
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} pathname - e.g. "listings/abc123/1700000000-xyz.jpg"
 * @param {string} contentType - e.g. "image/jpeg"
 * @returns {Promise<{ url: string, pathname: string }>}
 */
async function uploadBuffer(buffer, pathname, contentType) {
  requireToken();
  const blob = await put(pathname, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false,
  });
  return { url: blob.url, pathname: blob.pathname };
}

/**
 * @param {string} url - the full Blob URL previously returned by uploadBuffer
 */
async function deleteByUrl(url) {
  requireToken();
  if (!url) return;
  try {
    await del(url);
  } catch (err) {
    // Soft failure — a missing/already-deleted blob shouldn't block the
    // surrounding DB operation (e.g. deleting a Photo document).
    // eslint-disable-next-line no-console
    console.warn(`[blobStorage] Could not delete ${url}:`, err.message);
  }
}

function uniqueFilename(originalName) {
  const ext = (originalName.match(/\.[a-zA-Z0-9]+$/) || [''])[0];
  const unique = `${Date.now()}-${require('crypto').randomBytes(6).toString('hex')}`;
  return `${unique}${ext}`;
}

module.exports = { uploadBuffer, deleteByUrl, uniqueFilename };
