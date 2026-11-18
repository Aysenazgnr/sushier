// Thin wrapper around the Claude Messages API, used only by api/chat.js.
//
// Unlike api/_lib/supabase.js, this must NOT throw at import time when the
// key is missing -- a missing ANTHROPIC_API_KEY must take down only the
// chat widget, never the rest of the site (booking, availability, admin
// all import unrelated modules and must keep working). api/chat.js checks
// isConfigured() itself and answers 503 before ever calling createMessage.
//
// No SDK dependency added: the project deliberately carries a single
// dependency (@supabase/supabase-js) and the Messages API is one plain
// fetch call, so a second dependency isn't worth it for this.
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 20000;
// Chat's own budget (short conversational replies). api/_lib/digest.js
// passes a larger maxTokens for the daily inbox digest, which needs room
// for several ranked, summarized items.
const DEFAULT_MAX_TOKENS = 400;

function isConfigured() {
  return API_KEY !== '';
}

// params: { system, messages, tools, maxTokens }. maxTokens defaults to
// DEFAULT_MAX_TOKENS (chat's own budget) when omitted, so api/chat.js's
// existing calls are unaffected -- api/_lib/digest.js is the only caller
// that passes a larger value, for the daily inbox digest. Returns
// { ok:true, message } with the raw Anthropic response body on success,
// or { ok:false, code } on any failure -- network error, timeout,
// non-2xx status. Never throws: callers always get a result they can
// turn into an HTTP response.
async function createMessage({ system, messages, tools, maxTokens }) {
  if (!isConfigured()) {
    return { ok: false, code: 'chat_unavailable' };
  }

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens || DEFAULT_MAX_TOKENS,
        system,
        messages,
        tools
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!res.ok) {
      // Logged without the request/response body -- that body can carry
      // the visitor's own message text, and the API key never appears in
      // it, but there's no reason to put guest text in server logs either.
      console.error('[anthropic] API rejected the request:', res.status);
      return { ok: false, code: 'chat_upstream_error' };
    }

    const message = await res.json();
    return { ok: true, message };
  } catch (err) {
    console.error('[anthropic] request failed:', err && err.name, err && err.message);
    return { ok: false, code: 'chat_upstream_error' };
  }
}

module.exports = { isConfigured, createMessage, MODEL };
