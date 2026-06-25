/**
 * Run from the backend folder:
 *   node scripts/checkModels.js
 *
 * Lists every model the API key can see, then shows which ones
 * match what this app needs for each task.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_IMAGE_API_KEY = process.env.GEMINI_IMAGE_API_KEY || GEMINI_API_KEY;

const NEEDED = {
  'Text analysis (room detection, quality scoring, suggestions, listing copy)': {
    envVar: 'GEMINI_MODEL',
    current: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    key: GEMINI_API_KEY,
    keyName: 'GEMINI_API_KEY',
    needsImageOutput: false,
  },
  'Image editing (photo enhancement, defurnishing, smart editing)': {
    envVar: 'GEMINI_IMAGE_MODEL',
    current: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-exp',
    key: GEMINI_IMAGE_API_KEY,
    keyName: 'GEMINI_IMAGE_API_KEY',
    needsImageOutput: true,
  },
};

async function listModels(apiKey, keyName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ListModels failed for ${keyName} (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.models || [];
}

function supportsMethod(model, method) {
  return (model.supportedGenerationMethods || []).includes(method);
}

function modelLine(model) {
  const methods = (model.supportedGenerationMethods || []).join(', ');
  return `  ${model.name.replace('models/', '')}  [${methods}]`;
}

async function run() {
  console.log('\n====================================================');
  console.log('  Zenrth — Gemini Model Availability Check');
  console.log('====================================================\n');

  // Fetch models for both keys (deduplicate if same key)
  const keyResults = new Map();

  for (const task of Object.values(NEEDED)) {
    if (!keyResults.has(task.keyName)) {
      process.stdout.write(`Fetching models for ${task.keyName}... `);
      try {
        const models = await listModels(task.key, task.keyName);
        keyResults.set(task.keyName, { models, error: null });
        console.log(`${models.length} models found.`);
      } catch (err) {
        keyResults.set(task.keyName, { models: [], error: err.message });
        console.log(`ERROR — ${err.message}`);
      }
    }
  }

  console.log('\n----------------------------------------------------');
  console.log('  TASK REQUIREMENTS vs AVAILABLE MODELS');
  console.log('----------------------------------------------------\n');

  for (const [taskName, task] of Object.entries(NEEDED)) {
    const result = keyResults.get(task.keyName);
    console.log(`TASK: ${taskName}`);
    console.log(`  Key used   : ${task.keyName}`);
    console.log(`  Env var    : ${task.envVar}=${task.current}`);

    if (result.error) {
      console.log(`  Status     : ❌ Could not fetch models — ${result.error}\n`);
      continue;
    }

    const models = result.models;
    const currentModel = models.find(
      (m) => m.name === `models/${task.current}` || m.name.endsWith(`/${task.current}`)
    );

    if (currentModel) {
      const canGenerate = supportsMethod(currentModel, 'generateContent');
      console.log(`  Status     : ${canGenerate ? '✅' : '⚠️ '} Model found${canGenerate ? ', supports generateContent' : ', does NOT support generateContent'}`);
      if (task.needsImageOutput) {
        console.log(`  Note       : Image output capability cannot be verified via ListModels — test by running smart editing`);
      }
    } else {
      console.log(`  Status     : ❌ Model "${task.current}" NOT available for this API key`);
      console.log(`\n  Suggested alternatives (support generateContent):`);
      const alternatives = models
        .filter((m) => supportsMethod(m, 'generateContent'))
        .filter((m) => {
          const name = m.name.toLowerCase();
          return name.includes('flash') || name.includes('pro');
        })
        .slice(0, 8);
      if (alternatives.length) {
        alternatives.forEach((m) => console.log(modelLine(m)));
        if (task.needsImageOutput) {
          console.log(`\n  For image output, look for models with "exp" or "imagen" in the name above.`);
          console.log(`  If none found, image editing may not be available on this key/plan.`);
        }
      } else {
        console.log('  None found — the API key may not have access to any generative models.');
      }
    }
    console.log('');
  }

  console.log('----------------------------------------------------');
  console.log('  ALL MODELS SUPPORTING generateContent (both keys)');
  console.log('----------------------------------------------------\n');

  const allModels = new Set();
  for (const { models } of keyResults.values()) {
    for (const m of models) {
      if (supportsMethod(m, 'generateContent')) {
        allModels.add(m);
      }
    }
  }

  const sorted = [...allModels].sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length === 0) {
    console.log('  No models found — check that both API keys are valid.\n');
  } else {
    sorted.forEach((m) => console.log(modelLine(m)));
    console.log('');
  }

  console.log('====================================================\n');
}

run().catch((err) => {
  console.error('\nUnexpected error:', err.message);
  process.exit(1);
});
