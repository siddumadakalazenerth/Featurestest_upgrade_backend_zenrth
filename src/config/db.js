const dns = require('dns');
const mongoose = require('mongoose');

let connectingPromise = null;

// Serverless functions (Vercel) reuse the Node process between invocations,
// so we cache the connection instead of reconnecting on every request.
async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  if (connectingPromise) {
    return connectingPromise;
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

  connectingPromise = mongoose
    .connect(uri, {
      dbName,
      serverSelectionTimeoutMS: 10000,
    })
    .then((conn) => {
      console.log(`[mongo] connected -> ${mongoose.connection.name}`);
      mongoose.connection.on('error', (err) => {
        console.error('[mongo] connection error:', err.message);
      });
      return conn.connection;
    })
    .finally(() => {
      connectingPromise = null;
    });

  return connectingPromise;
}

module.exports = { connectDB };
