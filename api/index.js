require('dotenv').config();
const { createApp } = require('../src/app');
const { connectDB } = require('../src/config/db');

/**
 * Vercel serverless entry point. This is the ONLY new file Vercel needs to
 * run the existing Express app — every route, controller, and middleware in
 * src/ is used completely unchanged. There is no separate "Vercel version"
 * of the API; this file just adapts the same app to how Vercel invokes
 * Node.js functions.
 *
 * server.js (the local-dev entry point with app.listen()) is untouched and
 * still works exactly as before for `npm run dev` — Vercel never calls that
 * file at all. This file replaces it only in the deployed environment.
 *
 * connectDB() is called on every invocation, but config/db.js caches the
 * connection across warm invocations, so this is cheap except on a true
 * cold start.
 */

let app;

async function getApp() {
  // connectDB() itself is cheap when already connected (see config/db.js's
  // own caching) — calling it every time, not just on first creation, means
  // a dropped connection on a warm instance gets re-established automatically
  // rather than silently failing every subsequent request.
  await connectDB();
  if (!app) {
    app = createApp();
  }
  return app;
}

module.exports = async (req, res) => {
  const expressApp = await getApp();
  return expressApp(req, res);
};
