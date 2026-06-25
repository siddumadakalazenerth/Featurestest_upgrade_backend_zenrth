const { describeGeminiError } = require('./geminiErrorMessages');

const DEFAULT_MODEL = 'gemini-2.5-flash';

function getModel() {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

function endpoint() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${getModel()}:generateContent`;
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON object found in Gemini response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callGemini(parts, { json = true } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const response = await fetch(`${endpoint()}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.2,
        ...(json ? { response_mime_type: 'application/json' } : {}),
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const known = describeGeminiError(response.status, body);
    if (known) {
      const err = new Error(known.message);
      err.geminiReason = known.reason;
      throw err;
    }
    throw new Error(`Gemini task failed (${response.status}): ${body.slice(0, 400)}`);
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned no task result');
  return json ? extractJson(text) : text.trim();
}

async function imagePart(photo) {
  return {
    inline_data: {
      mime_type: photo.mimeType,
      data: photo.data.toString('base64'),
    },
  };
}

async function runMultiImageReview(listing, photos) {
  const candidates = photos.filter((photo) => photo.status === 'analyzed').slice(0, 8);
  if (candidates.length < 2) throw new Error('At least two analyzed images are required');

  const manifest = candidates.map((photo, index) => ({
    imageNumber: index + 1,
    photoId: String(photo._id),
    currentRoomType: photo.analysis?.roomType,
    issues: photo.analysis?.issues || [],
  }));
  const parts = [
    {
      text: `Review this complete real-estate photo set for "${listing.title}".
Return ONLY JSON:
{
  "summary": "one short seller-friendly summary",
  "duplicateGroups": [["photoId", "photoId"]],
  "roomLabelCorrections": [{"photoId":"id","suggestedRoomType":"type","reason":"short"}],
  "galleryOrder": ["photoId"],
  "coverPhotoId": "photoId or null",
  "warnings": ["short warning"],
  "suggestions": ["short actionable suggestion"]
}
Never invent property features. Use the photo IDs from this manifest:
${JSON.stringify(manifest)}`,
    },
  ];
  for (const photo of candidates) parts.push(await imagePart(photo));
  return callGemini(parts);
}

async function runContentReview(photo) {
  return callGemini([
    {
      text: `Review this real-estate image for publication risks. Return ONLY JSON:
{
  "safeToPublish": true,
  "risks": ["person, face, document, number plate, watermark, unsafe content, or misleading edit"],
  "recommendedAction": "publish, redact, replace, or remove",
  "explanation": "one short sentence"
}`,
    },
    await imagePart(photo),
  ]);
}

async function runFloorPlanReview(photo) {
  return callGemini([
    {
      text: `Analyze this floor plan conservatively. Return ONLY JSON:
{
  "isFloorPlan": true,
  "visibleRoomLabels": ["label"],
  "relationships": [{"from":"room","to":"room","confidence":0.0}],
  "uncertainItems": ["item requiring user confirmation"],
  "summary": "one short sentence"
}
Do not invent dimensions, doors, windows, or structural details that are not clearly visible.`,
    },
    await imagePart(photo),
  ]);
}

/**
 * Suggests furniture for an empty/sparse room photo, as text only — no image
 * is generated at this step. The seller reviews and accepts/edits/dismisses
 * this suggestion; only after acceptance does a virtual_staging image edit
 * (a separate, later tool job) get queued using these pieces as its brief.
 *
 * Room dimensions here are a rough visual estimate from a single 2D photo,
 * not a survey measurement — the prompt is written to make Gemini say so
 * explicitly rather than present a false-precision number.
 */
async function runFurnishingSuggestion(photo, knownDimensions, userPreferences = {}) {
  const dims = knownDimensions && knownDimensions.widthMeters && knownDimensions.lengthMeters
    ? knownDimensions
    : null;
  const dimensionInstruction = dims
    ? `The seller has measured this room: ${dims.widthMeters}m wide x ${dims.lengthMeters}m long. Use these exact figures for estimatedDimensions (set confidence to 1 and basis to "Provided by the seller") and size every suggested piece to fit within them.`
    : `Estimate the room's scale from visible reference objects (doors, windows, floor tiles, skirting boards, ceiling height) and suggest furniture that would suit the space.`;
  // User-specified room type takes priority over the AI-analyzed one
  const roomType = userPreferences.roomType || photo.analysis?.roomType || 'Other';
  const roomSubtype = photo.roomSubtype || null;
  const roomLabel = roomSubtype ? `${roomSubtype} (${roomType})` : roomType;
  const isBedroom = /bedroom/i.test(roomType) || /bedroom/i.test(roomSubtype || '');
  const userColorNote = Array.isArray(userPreferences.colorPalette) && userPreferences.colorPalette.length > 0
    ? `\n- The seller prefers these colors: ${userPreferences.colorPalette.join(', ')}. Use them as the primary palette if they complement the room's existing finishes.`
    : '';

  return callGemini([
    {
      text: `This is an empty or sparsely furnished ${roomLabel} in a real-estate listing photo.
${dimensionInstruction}

Return ONLY JSON with this exact shape:
{
  "roomType": "${roomType}",
  "roomSubtype": ${roomSubtype ? `"${roomSubtype}"` : 'null'},
  "estimatedDimensions": {
    "widthMeters": number or null,
    "lengthMeters": number or null,
    "areaSqMeters": number or null,
    "confidence": number from 0 to 1,
    "basis": "one short phrase naming the reference objects used to estimate scale"
  },
  "style": "one short style name matching the room's existing finishes, e.g. Modern, Minimal, Luxury, Traditional, Scandinavian",
  "colorPalette": ["2 to 3 named colors that tie the whole room together, e.g. 'warm white', 'natural oak', 'sage green accent'"],
  "lightingMood": "one short description of ideal lighting mood and colour temperature, e.g. 'warm ambient 2700K — use dimmable pendants and a floor lamp'",
  "pieces": [
    {
      "item": "specific furniture piece, e.g. '3-seater linen sofa' or 'queen bed with upholstered headboard'",
      "placement": "short, concrete placement instruction relative to visible walls/windows",
      "reason": "one short reason this piece fits this room"
    }
  ],
  "lighting": [
    {
      "item": "specific light fitting, e.g. 'dimmable pendant light', 'arc floor lamp', 'bedside table lamp'",
      "placement": "where to position it",
      "reason": "why this lighting type suits the room and mood"
    }
  ],
  "windowTreatments": {
    "type": "curtain or blind style, e.g. 'sheer linen curtains', 'wooden roller blind', 'floor-length velvet drapes'",
    "color": "color that coordinates with the palette, e.g. 'warm white', 'natural linen', 'charcoal grey'",
    "notes": "one short practical note on why this treatment suits the window(s) visible"
  }${isBedroom ? `,
  "bedding": {
    "bedSize": "e.g. 'queen', 'king', 'double'",
    "sheetColor": "color coordinated with the palette",
    "pillowArrangement": "e.g. '2 sleeping pillows + 2 accent cushions in sage green'",
    "duvet": "style and color, e.g. 'quilted white duvet with navy piping'"
  }` : ''},
  "summary": "one short seller-friendly sentence summarizing the complete room concept"
}

Rules:
- This is a visual estimate from one photo, not a survey measurement. Set confidence honestly.
- Suggest 3 to 5 furniture pieces. Prioritize pieces that help a buyer understand how the room is used.
- Every piece must plausibly fit the estimated dimensions.
- Lighting: suggest 2 to 3 light sources that layer ambient, task, and accent as appropriate.
- Window treatments: match color to the palette and suit the window size visible.
- Color palette: pick 2-3 colors that complement the room's existing walls and flooring.${userColorNote}
- Do not invent structural features, windows, doors, or room area beyond what is visible.
- If scale is too ambiguous, set estimatedDimensions values to null and explain in "basis".`,
    },
    await imagePart(photo),
  ]);
}

async function runFurnishingVerification(photo, customRequest) {
  const dims = photo.furnishingSuggestion?.estimatedDimensions || {};
  const roomArea = dims.widthMeters && dims.lengthMeters
    ? `${dims.widthMeters}m wide × ${dims.lengthMeters}m long (≈${dims.areaSqMeters || Math.round(dims.widthMeters * dims.lengthMeters)} sq m)`
    : 'estimated dimensions not available';
  return callGemini([
    {
      text: `You are a furniture layout expert reviewing a custom furnishing request for a ${photo.analysis?.roomType || 'room'} in a property listing.

Room dimensions: ${roomArea}
Basis for estimate: ${dims.basis || 'visual estimate from photo'}
Seller's request: "${customRequest}"

Analyze whether the requested furniture will realistically fit this room. Return ONLY JSON:
{
  "fits": true or false,
  "reason": "one clear sentence explaining the fit verdict",
  "pieces": [
    { "item": "piece name", "placement": "where it goes", "reason": "why it fits" }
  ],
  "sellerMessage": "one friendly sentence — positive if fits, honest alternative if not"
}

Rules:
- Standard sizes: king bed ≈1.9×2.1m, wardrobe ≈0.6×1.2m each, 3-seater sofa ≈2.2×0.9m, queen bed ≈1.6×2.1m
- If room dimensions are unknown, give reasonable benefit of the doubt for a standard room of this type
- If it doesn't fit, briefly say what would fit instead
- pieces array must be empty [] if fits=false`,
    },
    await imagePart(photo),
  ]);
}

async function runListingCopy(listing, photos) {
  const evidence = photos
    .filter((photo) => photo.status === 'analyzed' && photo.analysis?.suitable)
    .map((photo) => ({
      roomType: photo.analysis?.roomType,
      reasoning: photo.analysis?.reasoning,
    }));
  return callGemini([
    {
      text: `Prepare accurate real-estate listing copy using ONLY the confirmed evidence below.
Return ONLY JSON:
{
  "headline": "concise headline",
  "description": "two short paragraphs",
  "highlights": ["fact supported by evidence"],
  "factsToConfirm": ["anything the seller should supply before publishing"]
}
Listing: ${JSON.stringify({ title: listing.title, address: listing.address })}
Visual evidence: ${JSON.stringify(evidence)}`,
    },
  ]);
}

module.exports = {
  runMultiImageReview,
  runContentReview,
  runFloorPlanReview,
  runFurnishingSuggestion,
  runFurnishingVerification,
  runListingCopy,
};
