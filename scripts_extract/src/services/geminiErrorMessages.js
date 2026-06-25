/**
 * Recognizes a handful of Gemini/Google error shapes that are account or
 * credential problems (wrong key type, key blocked, no quota) rather than
 * something the app can retry its way out of, and returns a clean message
 * safe to show a non-technical seller. Returns null for anything else, so
 * callers can fall back to their own status-specific hints.
 */
function describeGeminiError(status, body) {
  if (status === 401 && /ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(body)) {
    return {
      reason: 'wrong_credential_type',
      message:
        'AI features are not configured correctly (the API key looks like a Google OAuth token, not a Gemini API key). This needs a fresh key from Google AI Studio — no retry will fix it.',
    };
  }
  if (status === 403 && /API_KEY_SERVICE_BLOCKED/.test(body)) {
    return {
      reason: 'api_blocked',
      message:
        'AI features are temporarily unavailable for this account (the API key is not allowed to use the Generative Language API yet). This needs to be enabled in the Google Cloud project — no retry will fix it until then.',
    };
  }
  if (status === 429 && /"limit"\s*:\s*0/.test(body)) {
    return {
      reason: 'quota_exhausted',
      message:
        'AI features are temporarily unavailable for this account (no quota allocated). Your other actions still work — this will start succeeding again once quota/billing is sorted, no further action needed here.',
    };
  }
  return null;
}

module.exports = { describeGeminiError };
