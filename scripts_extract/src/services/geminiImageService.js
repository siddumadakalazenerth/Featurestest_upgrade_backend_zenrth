const AssetVersion = require('../models/AssetVersion');
const { describeGeminiError } = require('./geminiErrorMessages');

function imageModel(tool) {
  if (tool === 'virtual_staging') {
    return process.env.GEMINI_IMAGE_MODEL_PRO || process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';
  }
  return process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
}

function buildTruthfulPrompt(job, photo) {
  const recommendation = photo.analysis?.recommendation || {};
  const structuralElements = recommendation.preserve?.length
    ? recommendation.preserve.join(', ')
    : 'walls, windows, doors, flooring, fixed fittings, room dimensions, and all factual property details';
  const issues = photo.analysis?.issues || [];
  const obstructionIssue = issues.find((i) => /obstruct|foreground/i.test(i));
  const obstructionHint = obstructionIssue
    ? '\nFocus on removing or minimizing the foreground obstruction. Blend the revealed area naturally with the existing background — do not invent new content.'
    : '';

  if (job.tool === 'custom_edit') {
    return `${job.prompt}

This is a real-estate listing image. Apply the requested change accurately and completely.
You MAY change: colors, textures, soft furnishings (bedding, cushions, curtains, rugs, throws), lighting effects, removable objects, and decorative items.
Do NOT change: ${structuralElements}.
Keep the result photorealistic and suitable for an honest property listing.
Return the edited image.`;
  }

  // Virtual staging: composite furniture onto the original photo — do not re-render the room.
  if (job.tool === 'virtual_staging_render') {
    // Pull every available detail from the prior Gemini analysis of this photo
    // and feed it back as a "what is already in this photo" checklist. This
    // grounds the model in the actual room rather than a generated version.
    const analysis = photo.analysis || {};
    const preserveList = recommendation.preserve?.length
      ? recommendation.preserve
      : ['walls', 'windows', 'doors', 'floor', 'ceiling', 'all fixed fixtures'];
    const reasoning = analysis.reasoning ? `Gemini's own description of this photo: "${analysis.reasoning}"` : '';
    const roomType = analysis.roomType || 'room';

    return `You are editing a real photograph of an empty ${roomType}. Study the attached photo carefully.

ITEMS TO ADD — these are the ONLY changes you may make to the photo:
${job.prompt}

When placing each item, match the exact perspective, scale, and shadow direction already present in the photo.

━━━ EVERYTHING ELSE IS ALREADY IN THE PHOTO — DO NOT CHANGE IT ━━━

${reasoning}

The following elements are visible in the attached photo and must appear IDENTICALLY in your output:
${preserveList.map((el) => `- ${el}`).join('\n')}

Specific rules:
1. CAMERA: The output must be shot from the exact same position, angle, height, and focal length as the input. Do not zoom, pan, tilt, or reframe in any way.
2. WALLS: Same color, same texture, same corner angles. If walls meet at an L-shape or any angle, preserve that exact geometry.
3. WINDOWS: Every window in the input must appear in the output at the exact same position, size, and frame. The outdoor view through each window must be identical. Do NOT add, remove, resize, or move any window.
4. CEILING: Same height, same color. Every ceiling fixture (recessed lights, fan, vents) stays in its exact position — do not remove or replace any ceiling fixture.
5. FLOOR: Same material, color, and grain direction.
6. DOORS & ACCENT WALLS: All doors and wall finishes (shiplap, paneling, tiles) unchanged.
7. Any part of the room not covered by placed furniture must look pixel-identical to the input photo.

Return the edited image.`;
  }

  const basePrompt = `${job.prompt || recommendation.editPrompt}${obstructionHint}`;
  return `${basePrompt}

This is a real-estate listing image. Make only the requested truthful correction.
Preserve exactly: ${structuralElements}.
Do not add, enlarge, remove, relocate, or invent architecture, windows, doors, room area, views, fixtures, or permanent property features.
Keep the result photorealistic and suitable for an honest property listing.
Return the edited image.`;
}

async function runGeminiImageEdit(job, photo) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const source = photo.data; // Buffer pulled straight from MongoDB — no disk involved
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${imageModel(job.tool)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildTruthfulPrompt(job, photo) },
              {
                inline_data: {
                  mime_type: photo.mimeType,
                  data: source.toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      }),
    }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const known = describeGeminiError(response.status, body);
    if (known) {
      const err = new Error(known.message);
      err.geminiReason = known.reason;
      throw err;
    }
    const hint = response.status === 404
      ? ` — model "${imageModel(job.tool)}" may be retired. Set GEMINI_IMAGE_MODEL=gemini-2.5-flash-image in backend/.env`
      : response.status === 400 && body.includes('text output')
        ? ` — model "${imageModel(job.tool)}" does not support image output. Set GEMINI_IMAGE_MODEL=gemini-2.5-flash-image`
        : response.status === 429
          ? ' — rate limited, try again shortly.'
          : '';
    throw new Error(`Gemini image editing failed (${response.status}): ${body.slice(0, 500)}${hint}`);
  }
  const payload = await response.json();
  const candidate = payload?.candidates?.[0];
  const finishReason = candidate?.finishReason;

  // Safety block, recitation, or other refusal
  if (finishReason && finishReason !== 'STOP') {
    const textParts = (candidate?.content?.parts || [])
      .filter((p) => p.text).map((p) => p.text).join(' ').slice(0, 300);
    const safetyMsg =
      finishReason === 'SAFETY'
        ? 'The model refused this edit (safety policy). Try rephrasing the prompt — e.g. say what to remove rather than referencing who/what it is.'
        : `Gemini stopped early (${finishReason}).`;
    throw new Error(`${safetyMsg}${textParts ? ' Model said: "' + textParts + '"' : ''}`);
  }

  const parts = candidate?.content?.parts || [];
  const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;

  if (!inlineData?.data) {
    const textReply = parts.filter((p) => p.text).map((p) => p.text).join(' ').slice(0, 300);
    const modelUsed = imageModel(job.tool);
    const textHint = textReply
      ? `Model replied with text only: "${textReply}"`
      : `Model "${modelUsed}" returned no image data.`;
    const fixHint = ` Check that your GEMINI_API_KEY has image-generation access enabled in Google AI Studio, and that GEMINI_IMAGE_MODEL is set to a model that supports image output.`;
    throw new Error(`${textHint}${fixHint}`);
  }

  const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
  const buffer = Buffer.from(inlineData.data, 'base64');

  const version = new AssetVersion({
    listing: job.listing,
    photo: photo._id,
    toolJob: job._id,
    kind: 'generated',
    url: 'pending', // placeholder, replaced below once we know the _id
    data: buffer,
    mimeType,
    sizeBytes: buffer.length,
    selected: false,
    metadata: {
      provider: 'gemini',
      model: imageModel(job.tool),
      tool: job.tool,
      prompt: job.prompt,
      synthIdExpected: true,
    },
  });
  version.url = `/api/images/versions/${version._id}`;
  await version.save();
  return { version, url: version.url };
}

module.exports = { runGeminiImageEdit };
