// POST /api/chat
//
// Stateless chat endpoint for the floating widget (js/chat.js): the
// browser resends the whole conversation on every turn and nothing is
// persisted here or in Supabase -- no chat_messages table, no Telegram
// notification, no log of message text. This is a deliberate decision,
// not an oversight; see api/_lib/validate.js's validateChatBody.
//
// Two tools let the model ground itself in real data instead of guessing:
//   - check_availability reads the same get_availability RPC
//     api/availability.js already uses, read-only.
//   - prefill_reservation never writes a reservation itself -- it
//     validates the visitor's date/party/time against that same RPC and,
//     if valid, short-circuits the request with an `action` the browser
//     uses to fill and scroll to the existing booking form (js/chat.js +
//     js/reservation.js's prefill() hook). The model is not asked to
//     compose a sentence for that case: a fixed TR/EN template is used so
//     a confirmed, validated booking intent can't be re-described wrong.
const { supabase } = require('./_lib/supabase');
const { isConfigured, createMessage } = require('./_lib/anthropic');
const { buildSystemPrompt } = require('./_lib/chat-knowledge');
const { validateChatBody, validateDateParam } = require('./_lib/validate');

const MAX_BODY_BYTES = 12 * 1024;
const MAX_TOOL_ROUNDS = 3;

const TOOLS = [
  {
    name: 'check_availability',
    description:
      "Get live availability for one date: whether the restaurant is open that day, and remaining tables per time slot. Always call this before telling a visitor whether a specific date or time is available -- never guess or rely on general hours for a specific day.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' }
      },
      required: ['date']
    }
  },
  {
    name: 'prefill_reservation',
    description:
      "Send the visitor to the reservation form with date, party size and (if known) a specific time slot already filled in. Call this once the visitor has confirmed a date and party size they want to book -- a specific slotMinute from a prior check_availability result is welcome but optional. This does not create a reservation; it only prepares the form. Do not call this just to check whether something is available -- use check_availability for that.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        partySize: { type: 'integer' },
        slotMinute: {
          type: 'integer',
          description: 'Minutes from midnight for the chosen time slot, taken from a prior check_availability result. Omit if the visitor has not picked a specific time yet.'
        }
      },
      required: ['date', 'partySize']
    }
  }
];

const PREFILL_REPLY = {
  tr(date, partySize, time) {
    return 'Harika, sizi ' + date + ' tarihi, ' + partySize + ' kişi' + (time ? ', saat ' + time : '') +
      ' için rezervasyon formuna yönlendiriyorum -- sadece isim ve telefon kalıyor.';
  },
  en(date, partySize, time) {
    return "Great, I'm sending you to the reservation form for " + date + ', party of ' + partySize +
      (time ? ' at ' + time : '') + " -- just name and phone left to fill in.";
  }
};

const FALLBACK_REPLY = {
  tr: 'Üzgünüm, şu an bunu tam olarak yanıtlayamadım -- bizi +90 000 000 00 00 numarasından arayabilirsiniz.',
  en: "Sorry, I couldn't fully answer that just now -- feel free to call us at +90 000 000 00 00."
};

async function execCheckAvailability(input) {
  const dateResult = validateDateParam(input && input.date);
  if (!dateResult.ok) {
    return { ok: false, code: dateResult.code };
  }

  const { data, error } = await supabase.rpc('get_availability', { p_date: dateResult.date });
  if (error) {
    return { ok: false, code: 'server_error' };
  }
  return data;
}

// Returns { error:false, date, partySize, slotMinute, slotTime } once the
// request has been validated against live availability, or
// { error:true, body } with the same {ok:false, code} shape the rest of
// the API uses, so the model can explain the problem and suggest an
// alternative instead of the form ever being filled with something the
// booking RPC would reject anyway.
async function execPrefillReservation(input) {
  const dateResult = validateDateParam(input && input.date);
  if (!dateResult.ok) {
    return { error: true, body: { ok: false, code: dateResult.code } };
  }

  const partySize = Number(input && input.partySize);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) {
    return { error: true, body: { ok: false, code: 'party_size_out_of_range' } };
  }

  let slotMinute = null;
  if (input && input.slotMinute !== undefined && input.slotMinute !== null) {
    const sm = Number(input.slotMinute);
    if (!Number.isInteger(sm) || sm < 0 || sm > 1680) {
      return { error: true, body: { ok: false, code: 'invalid_slot' } };
    }
    slotMinute = sm;
  }

  const { data, error } = await supabase.rpc('get_availability', { p_date: dateResult.date });
  if (error || !data || !data.ok) {
    return { error: true, body: { ok: false, code: 'server_error' } };
  }

  if (data.closed) {
    return { error: true, body: { ok: false, code: 'date_closed', reason: data.reason } };
  }

  if (partySize < data.minPartySize || partySize > data.maxPartySize) {
    return {
      error: true,
      body: { ok: false, code: 'party_size_out_of_range', minPartySize: data.minPartySize, maxPartySize: data.maxPartySize }
    };
  }

  let slotTime = null;
  if (slotMinute !== null) {
    const slot = (data.slots || []).find((s) => s.slotMinute === slotMinute);
    if (!slot) {
      return { error: true, body: { ok: false, code: 'invalid_slot' } };
    }
    if (!slot.bookable) {
      return { error: true, body: { ok: false, code: 'slot_full' } };
    }
    slotTime = slot.time;
  }

  return { error: false, date: dateResult.date, partySize, slotMinute, slotTime };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, code: 'method_not_allowed' });
    return;
  }

  // Checked before touching the request body: a missing key must answer
  // the same clean 503 regardless of what the visitor typed, so the
  // widget can show "live chat is unavailable" without anything looking
  // like a broken feature.
  if (!isConfigured()) {
    res.status(503).json({ ok: false, code: 'chat_unavailable' });
    return;
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('application/json')) {
    res.status(415).json({ ok: false, code: 'unsupported_media_type' });
    return;
  }

  const bodySize = Buffer.byteLength(JSON.stringify(req.body || {}));
  if (bodySize > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, code: 'payload_too_large' });
    return;
  }

  const validation = validateChatBody(req.body);
  if (!validation.ok) {
    res.status(400).json({ ok: false, code: validation.code });
    return;
  }

  const { messages: history, lang } = validation.data;
  const system = await buildSystemPrompt();

  // Anthropic's message format: a plain string is shorthand for a single
  // text block. Tool rounds below switch content to block arrays as the
  // loop progresses.
  let messages = history.map((m) => ({ role: m.role, content: m.content }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await createMessage({ system, messages, tools: TOOLS });
    if (!result.ok) {
      res.status(502).json({ ok: false, code: result.code });
      return;
    }

    const { message } = result;
    const toolUses = (message.content || []).filter((b) => b.type === 'tool_use');

    if (message.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const reply = (message.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      res.status(200).json({ ok: true, reply: reply || FALLBACK_REPLY[lang], action: null });
      return;
    }

    // The assistant turn that requested the tool(s) must stay in the
    // transcript, tool_use blocks and all, immediately before the
    // tool_result turn that answers it -- Anthropic's API requires this
    // pairing even though the result is never sent back to the browser.
    messages = messages.concat([{ role: 'assistant', content: message.content }]);

    const toolResultBlocks = [];
    let shortCircuit = null;

    for (const toolUse of toolUses) {
      if (toolUse.name === 'prefill_reservation') {
        const outcome = await execPrefillReservation(toolUse.input);
        if (!outcome.error && !shortCircuit) {
          shortCircuit = {
            action: { type: 'prefill', date: outcome.date, partySize: outcome.partySize, slotMinute: outcome.slotMinute },
            reply: PREFILL_REPLY[lang](outcome.date, outcome.partySize, outcome.slotTime)
          };
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ ok: true }) });
        } else {
          const body = outcome.error ? outcome.body : { ok: false, code: 'already_handled' };
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(body), is_error: true });
        }
        continue;
      }

      if (toolUse.name === 'check_availability') {
        const data = await execCheckAvailability(toolUse.input);
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(data) });
        continue;
      }

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify({ ok: false, code: 'unknown_tool' }),
        is_error: true
      });
    }

    // A validated prefill is a final answer -- the fixed template above
    // already says everything the visitor needs, so no further model
    // call is spent composing a sentence for it (see file header).
    if (shortCircuit) {
      res.status(200).json({ ok: true, reply: shortCircuit.reply, action: shortCircuit.action });
      return;
    }

    messages = messages.concat([{ role: 'user', content: toolResultBlocks }]);
  }

  // Exhausted MAX_TOOL_ROUNDS without a plain-text answer or a validated
  // prefill -- only happens if the model keeps calling tools instead of
  // answering. Better to say so than to loop or leave the visitor waiting.
  res.status(200).json({ ok: true, reply: FALLBACK_REPLY[lang], action: null });
};
