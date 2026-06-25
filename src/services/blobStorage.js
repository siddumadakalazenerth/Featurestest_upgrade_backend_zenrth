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

function requireToken() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set. Connect Vercel Blob to this project ' +
        '(Vercel dashboard → Storage → Blob) or set the token in your local .env.'
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
