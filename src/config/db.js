const dns = require('dns');
const mongoose = require('mongoose');

// On a long-running server this only ever runs once at boot. On Vercel,
// each serverless invocation could otherwise call connectDB() from scratch —
// slow, and risks exceeding the Atlas connection pool under concurrent
// requests. Caching the in-flight/completed connection on a module-level
// variable lets a warm function instance reuse it across invocations; a
// cold start still connects fresh, same as local dev always did.
let cachedConnection = null;

async function connectDB() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME || 'zenrth';

  if (!uri) {
    throw new Error('MONGO_URI is not set. Copy backend/.env.example to backend/.env and fill it in.');
  }

  if (uri.startsWith('mongodb+srv://')) {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    console.log('[mongo] using public DNS servers for Atlas SRV resolution');
  }

  mongoose.set('strictQuery', true);

  cachedConnection = await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 10000,
    // Keep the pool small — serverless functions run many short-lived
    // instances, so each one only needs a handful of connections, not the
    // default pool sized for one long-running process.
    maxPoolSize: 10,
  });
  console.log(`[mongo] connected -> ${mongoose.connection.name}`);

  mongoose.connection.on('error', (err) => {
    console.error('[mongo] connection error:', err.message);
  });

  return cachedConnection;
}

module.exports = { connectDB };
