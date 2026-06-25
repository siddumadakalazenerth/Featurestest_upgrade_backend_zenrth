// Vercel serverless entry point. Every request to /api/* on this project
// is routed here (see vercel.json), which boots the same Express app used
// for local dev and makes sure MongoDB is connected before handling it.
const { createApp } = require('../src/app');
const { connectDB } = require('../src/config/db');

const app = createApp();
let dbReady = null;

module.exports = async (req, res) => {
  try {
    if (!dbReady) dbReady = connectDB();
    await dbReady;
  } catch (err) {
    dbReady = null; // allow a retry on the next request
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Database connection failed: ${err.message}` }));
    return;
  }
  return app(req, res);
};
