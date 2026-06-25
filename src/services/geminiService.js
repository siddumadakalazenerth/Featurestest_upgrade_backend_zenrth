const { ROOM_TYPES } = require('../constants');
const { describeGeminiError } = require('./geminiErrorMessages');

const DEFAULT_MODEL = 'gemini-2.5-flash';

const ANALYSIS_PROMPT = `You are a quality-control assistant for a real-estate listing platform.
Look at the attached property photo and classify it.

Respond with ONLY a single valid JSON object (no markdown fences, no commentary) with this exact shape:
{
  "assetType": "property_photo" or "floor_plan",
  "roomType": one of [${ROOM_TYPES.map((r) => `"${r}"`).join(', ')}],
  "scoreBreakdown": {
    "lighting": integer from 0 to 2,
    "sharpness": integer from 0 to 2,
    "composition": integer from 0 to 2,
    "cleanliness": integer from 0 to 2,
    "listingReadiness": integer from 0 to 2
  },
  "suitable": boolean (true if this photo is usable on a live listing as-is or after light enhancement),
  "issues": array of short strings describing any problems (e.g. "blurry", "too dark", "person in frame", "duplicate-looking"). Empty array if none,
  "reasoning": one short sentence explaining the score,
  "emptyRoom": boolean (true only for an interior room that is unfurnished or has very sparse furniture, making it hard for a buyer to judge how the space would be used. False for exteriors, bathrooms, kitchens with fitted units, and floor plans),
  "recommendation": {
    "action": one of ["none", "reupload", "photo_enhancement", "defurnishing", "smart_editing", "content_moderation", "virtual_staging"],
    "sellerSuggestion": one short, practical instruction shown to the property seller,
    "editPrompt": a precise image-editing prompt tailored to this exact image, or an empty string when action is "none", "reupload", or "virtual_staging",
    "preserve": array of property details that an image edit must not change,
    "confidence": number from 0 to 1
  },
  "floorPlan": {
    "rooms": array of visible room labels, empty for a normal property photo,
    "confidence": number from 0 to 1,
    "notes": one short sentence, empty for a normal property photo
  }
}

Room classification rules:
- For open-plan spaces where both a dining area (table and chairs) AND a living/lounge area (sofa, armchairs, coffee table) are visible in the same frame, classify as "Living Room" — the lounge seating indicates this is the primary living space.
- Only classify as "Dining Room" when the dining table is the ONLY significant furniture and no lounge seating is visible.

Scoring rules:
- 0 = poor or seriously problematic
- 1 = acceptable but visibly imperfect
- 2 = strong professional-listing quality
- The final quality score is calculated by the application as the sum of the five criteria (maximum 10).
- If the image is a floor plan, set assetType to "floor_plan", extract only visible room labels, and do not invent dimensions, walls, doors, or windows.
- Include privacy or publishing risks in issues, such as a person, face, document, number plate, watermark, or misleading content.
- IMPORTANT: If the issues array is non-empty, action must NOT be "none" — choose the most appropriate correction action for the problem listed.
- Choose "reupload" when blur, resolution, framing, obstruction, or missing visual information cannot be repaired honestly.
- Choose "photo_enhancement" for exposure, white balance, colour, contrast, or clarity improvements.
- Choose "defurnishing" only when removable furniture or clutter is the primary problem.
- Choose "smart_editing" for perspective correction, careful cropping, partial obstruction by a foreground object, or removal of a small non-structural distraction.
- Choose "content_moderation" when privacy, safety, watermark, person, document, or number-plate review is required.
- Choose "virtual_staging" when emptyRoom is true and furnishing the space would meaningfully help a buyer understand the room — leave editPrompt empty for this action, a separate step produces furniture suggestions.
- editPrompt must describe only truthful corrections. Never add rooms, space, windows, doors, views, furniture, fixtures, or architectural features.
- preserve should name visible structural and factual elements such as walls, windows, doors, flooring, fixed fittings, room dimensions, and exterior surroundings.
- Do not award 2 for a criterion unless the image clearly earns it.`;

function getModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

function buildEndpoint(model = getModel()) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function extractJson(text) {
  // Gemini sometimes wraps JSON in ```json fences even when told not to; strip defensively.
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in Gemini response');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Sends one photo to Gemini Flash for room-type / quality / suitability classification.
 * @param {string} imageUrl public Vercel Blob URL for the stored image
 * @param {string} mimeType e.g. "image/jpeg"
 * @returns {Promise<{roomType, qualityScore, suitable, issues, reasoning, raw, model}>}
 */
async function analyzeImage(imageUrl, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to backend/.env (copy from .env.example) and restart the server.'
    );
  }

  const fileResponse = await fetch(imageUrl);
  if (!fileResponse.ok) {
    throw new Error(`Could not fetch photo from storage (${fileResponse.status}): ${imageUrl}`);
  }
  const fileBuffer = Buffer.from(await fileResponse.arrayBuffer());
  const base64Data = fileBuffer.toString('base64');
  const model = getModel();

  const body = {
    contents: [
      {
        parts: [
          { text: ANALYSIS_PROMPT },
          { inline_data: { mime_type: mimeType, data: base64Data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      response_mime_type: 'application/json',
    },
  };

  const response = await fetch(`${buildEndpoint(model)}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');

    const known = describeGeminiError(response.status, errText);
    if (known) {
      const err = new Error(known.message);
      err.geminiReason = known.reason;
      throw err;
    }

    if (response.status === 404) {
      throw new Error(
        `Gemini model "${model}" is unavailable. Set GEMINI_MODEL=${DEFAULT_MODEL} in backend/.env, ` +
          `restart the backend, and try again. Google response: ${errText.slice(0, 300)}`
      );
    }

    throw new Error(`Gemini API error (${response.status}): ${errText.slice(0, 500)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';

  if (!text) {
    throw new Error('Gemini returned no text content (the photo may have been blocked by safety filters)');
  }

  let parsed;
  try {
    parsed = extractJson(text);
  } catch (e) {
    throw new Error(`Could not parse Gemini's response as JSON: ${e.message}`);
  }

  const roomType = ROOM_TYPES.includes(parsed.roomType) ? parsed.roomType : 'Other';
  const criteria = ['lighting', 'sharpness', 'composition', 'cleanliness', 'listingReadiness'];
  const scoreBreakdown = Object.fromEntries(
    criteria.map((criterion) => [
      criterion,
      Math.max(0, Math.min(2, Math.round(Number(parsed.scoreBreakdown?.[criterion]) || 0))),
    ])
  );
  const qualityScore = Object.values(scoreBreakdown).reduce((sum, score) => sum + score, 0);

  return {
    assetType: parsed.assetType === 'floor_plan' ? 'floor_plan' : 'property_photo',
    roomType,
    qualityScore,
    scoreBreakdown,
    suitable: Boolean(parsed.suitable),
    issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 10).map(String) : [],
    reasoning: String(parsed.reasoning || '').slice(0, 300),
    emptyRoom: Boolean(parsed.emptyRoom),
    recommendation: {
      action: [
        'none',
        'reupload',
        'photo_enhancement',
        'defurnishing',
        'smart_editing',
        'content_moderation',
        'virtual_staging',
      ].includes(parsed.recommendation?.action)
        ? parsed.recommendation.action
        : 'none',
      sellerSuggestion: String(parsed.recommendation?.sellerSuggestion || '').slice(0, 500),
      editPrompt: String(parsed.recommendation?.editPrompt || '').slice(0, 1500),
      preserve: Array.isArray(parsed.recommendation?.preserve)
        ? parsed.recommendation.preserve.slice(0, 20).map((item) => String(item).slice(0, 120))
        : [],
      confidence: Math.max(0, Math.min(1, Number(parsed.recommendation?.confidence) || 0)),
    },
    floorPlan: {
      rooms: Array.isArray(parsed.floorPlan?.rooms)
        ? parsed.floorPlan.rooms.slice(0, 30).map((room) => String(room).slice(0, 80))
        : [],
      confidence: Math.max(0, Math.min(1, Number(parsed.floorPlan?.confidence) || 0)),
      notes: String(parsed.floorPlan?.notes || '').slice(0, 300),
    },
    raw: data,
    model,
  };
}

module.exports = { analyzeImage };
