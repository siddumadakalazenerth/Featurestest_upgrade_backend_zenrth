require('dotenv').config();
const { createApp } = require('./app');
const { connectDB } = require('./config/db');
const { resumePendingPhotos } = require('./services/photoQueue');
const { resumeQueuedToolJobs } = require('./services/toolQueue');

const PORT = process.env.PORT || 4000;

async function printAvailableGeminiModels() {
  const apiKey = process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`
    );
    if (!res.ok) {
      console.warn(`[gemini] Could not list models (${res.status}): ${await res.text().catch(() => '')}`);
      return;
    }
    const data = await res.json();
    const allModels = data.models || [];

    // Models that support generateContent AND image output (responseModalities includes IMAGE)
    const imageOutputModels = allModels.filter((m) => {
      const methods = m.supportedGenerationMethods || [];
      const outputModalities = m.outputTokenLimit > 0 || methods.includes('generateContent');
      const name = m.name.replace('models/', '');
      return methods.includes('generateContent') && /image/i.test(name);
    });

    const allNames = allModels.map((m) => m.name.replace('models/', ''));
    console.log(`[gemini] ${allNames.length} models available for this API key:`);
    allNames.forEach((name) => console.log(`         • ${name}`));

    console.log(`\n[gemini] Models with "image" in name (likely image-output capable):`);
    if (imageOutputModels.length === 0) {
      console.log('         (none detected)');
    } else {
      imageOutputModels.forEach((m) => {
        const name = m.name.replace('models/', '');
        const methods = (m.supportedGenerationMethods || []).join(', ');
        console.log(`         • ${name}  [methods: ${methods}]`);
      });
    }

    const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const found = allNames.includes(imageModel);
    console.log(
      found
        ? `\n[gemini] ✓ GEMINI_IMAGE_MODEL="${imageModel}" is available`
        : `\n[gemini] ✗ GEMINI_IMAGE_MODEL="${imageModel}" NOT found — image editing will fail`
    );
  } catch (err) {
    console.warn('[gemini] Model list fetch failed:', err.message);
  }
}

async function start() {
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      '[warn] GEMINI_API_KEY is not set — photo uploads will be stored but analysis calls will fail.\n' +
        '       Copy backend/.env.example to backend/.env and add your key.'
    );
  }

  await printAvailableGeminiModels();
  await connectDB();
  await resumePendingPhotos();
  await resumeQueuedToolJobs();

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[server] Zenrth API listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('[fatal] failed to start server:', err.message);
  process.exit(1);
});
