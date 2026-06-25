# Deploying to Vercel — what changed and what you still need to do

This backend was built for a long-running Node server (local disk storage,
an in-memory job queue, `app.listen()`). None of those three things work on
Vercel's serverless functions. This document explains exactly what was
changed to make it work, and the manual steps you still need to do in the
Vercel dashboard before this will actually run.

## What changed in the code

### 1. File storage: local disk → Vercel Blob

- `src/middleware/upload.js` — Multer now uses `memoryStorage()` instead of
  `diskStorage()`. Files arrive as in-memory buffers, never written to disk.
- `src/services/blobStorage.js` (new) — the only file that imports
  `@vercel/blob` directly. Everything else calls `uploadBuffer()` /
  `deleteByUrl()` from here.
- `src/models/Photo.js`, `src/models/AssetVersion.js` — `diskPath` replaced
  with `blobUrl` (the full public Blob URL — it *is* the file's location,
  so there's no separate "path" concept anymore).
- `src/controllers/photoController.js`, `src/controllers/listingController.js`
  — every place that did `fs.readFile`, `fs.writeFile`, `fs.unlink`, or
  referenced `.diskPath` now uses `blobUrl` and the Blob SDK instead.
- `src/services/geminiService.js`, `src/services/geminiTaskService.js`,
  `src/services/geminiImageService.js` — these send images to Gemini. They
  used to `fs.readFile()` the source image; now they `fetch()` it from its
  public Blob URL, since Blob URLs are public HTTPS and Gemini can be
  pointed at base64 data either way.
- `src/app.js` — removed the `app.use('/uploads', express.static(...))` line
  entirely. There's nothing under this app's own domain to serve anymore —
  every photo URL is already a full Blob URL.

### 2. In-memory job queues → synchronous processing

`src/services/photoQueue.js` and `src/services/toolQueue.js` used to keep a
`const queue = []` array at module scope and process it in the background.
That only works on a server that stays running between requests. On Vercel,
every invocation is a fresh, isolated process — that array would reset to
empty before the job finished, silently losing work.

**Decision made:** process synchronously instead of standing up a separate
queue service (see the conversation that led here — async-via-polling would
still need *something* to run the background job on Vercel, which means new
infrastructure, not just a config change). Both files now run each photo/job
to completion, awaited, inside the same request that triggered it.

Every controller call site that used to fire-and-forget
(`enqueuePhotos([...])` with no `await`) now does `await enqueuePhotos([...])`
and re-fetches the updated record before responding, so the API response
reflects the finished work, not the pre-processing state.

**What this means for the UI:** an upload request now waits for Gemini
analysis to finish before responding (typically 2-5s per photo). An
enhancement/staging request waits for image generation (can be 10-30s). This
is why `vercel.json` sets `maxDuration: 60` on the function — comfortably
covers the slow case.

### 3. `server.js` is untouched — `api/index.js` is the new Vercel entry point

`src/server.js` (with `app.listen()`) still works exactly as before for
local development (`npm run dev`). Vercel never calls that file.

`api/index.js` (new) wraps the same Express app (`createApp()` from
`src/app.js` — zero route changes) in the function signature Vercel expects.
`vercel.json` rewrites every request to this one file.

### 4. Smaller fixes found along the way

- `src/constants/index.js` — `UPLOAD_LIMITS.maxBytesPerListing` was 5 MB,
  which is *over* Vercel's hard 4.5 MB serverless request body limit. A
  valid 5-photo upload near that size would have been rejected by Vercel
  itself with a generic error, before this app's own validation ever ran.
  Lowered to 4 MB to leave headroom.
- `src/config/db.js` — the Mongo connection is now cached across warm
  serverless invocations instead of reconnecting every time, and the
  connection pool size is capped at 10 (sized for many short-lived function
  instances, not one long-running process).
- `package.json` — added `@vercel/blob` as a dependency; bumped the Node
  engine requirement from `>=18.0.0` to `>=20.0.0` (Blob's actual minimum).
- `.gitignore` (new) — didn't exist before. The zip you uploaded contained
  your real `.env` with live secrets and ~95 MB of test upload images,
  because nothing was excluding them from the archive. Added one.
- `.env.example` (new) — also didn't exist. Documents every variable your
  real `.env` already uses, plus the new `BLOB_READ_WRITE_TOKEN`.

### 5. Frontend fixes (in the separate frontend zip you shared)

- `lib/api.ts`'s `resolvePhotoUrl()` assumed every photo URL was a relative
  path like `/uploads/...` and always prefixed it with the API base URL.
  Photo URLs are now full Blob URLs — prefixing them again would have
  produced a broken, double-prefixed URL. Fixed to pass full URLs through
  unchanged.
- `next.config.mjs` — Next.js blocks `<Image>` from loading external
  domains unless explicitly allowed. Added `*.public.blob.vercel-storage.com`
  to `remotePatterns`, or every photo and AI-generated image would fail to
  render.

## What you still need to do (cannot be done from code)

1. **Connect Vercel Blob to your project.** Vercel dashboard → your project
   → Storage → Connect Store → Blob. This automatically adds
   `BLOB_READ_WRITE_TOKEN` to your project's environment variables — you
   don't need to copy it manually when deployed on Vercel.

2. **Set your other environment variables in the Vercel dashboard.**
   Everything in `.env.example` needs a real value set under Project
   Settings → Environment Variables: `MONGO_URI` (your Atlas connection
   string), `MONGO_DB_NAME`, `GEMINI_API_KEY`, `GEMINI_IMAGE_API_KEY`,
   `CORS_ORIGIN` (set this to your deployed frontend's actual URL, not
   `localhost:3000`), and the rest.

3. **Deploy the frontend separately (or alongside) on Vercel**, and set its
   `NEXT_PUBLIC_API_URL` to point at this backend's deployed URL.

4. **Atlas network access:** make sure your Atlas cluster's IP allowlist
   includes `0.0.0.0/0` (allow from anywhere), since Vercel's serverless
   functions don't have a fixed IP you can allowlist individually.

## What was NOT changed

- Every route, controller business-logic decision, Gemini prompt, and the
  property-assessment/guidance logic is untouched. This was a storage and
  infrastructure migration, not a feature change.
- Auth: already a no-op (`requireAuth` injects a fixed `DEFAULT_USER`) from
  before this migration — confirmed, not modified.

## Testing status

Same limitation as every prior session on this project: no outbound network
access in the environment this was written in, so `npm install`,
`@vercel/blob`'s actual upload/delete calls, a live MongoDB Atlas
connection, and a real Gemini API call were never exercised end-to-end here.
Every `.js` file was checked with `node --check` (full sweep, zero syntax
errors). One real structural bug was caught and fixed during that process —
an edit to `toolQueue.js` left an orphaned function body with `module.exports`
in the wrong place; the syntax check caught it immediately and it was
rewritten cleanly.

Given the scope of this change, treat the first real deploy as the actual
test: upload a photo, confirm it appears with a Blob URL (not a broken
image), confirm analysis results populate, and try one enhancement/staging
action to confirm the 60s timeout is sufficient.
