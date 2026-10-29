// POST /api/reservations
// Writes a booking through the race-safe create_reservation RPC. All
// business rules (hours, capacity, closed dates, lead time, rate limit)
// are enforced again inside that RPC -- validation here is a fast,
// cheap first pass, not the authority.
const { supabase } = require('./_lib/supabase');
const { validateReservationBody } = require('./_lib/validate');
const { getClientIp, hashIp } = require('./_lib/ip');

const MAX_BODY_BYTES = 8 * 1024;

const RPC_ERROR_STATUS = {
  party_size_out_of_range: 400,
  invalid_slot: 400,
  too_far_ahead: 400,
  date_closed: 409,
  slot_in_past: 409,
  slot_full: 409,
  rate_limited: 429
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, code: 'method_not_allowed' });
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

  const validation = validateReservationBody(req.body);
  if (!validation.ok) {
    res.status(400).json({ ok: false, code: validation.code });
    return;
  }

  const { date, slotMinute, partySize, name, phone, email, notes, honeypotFilled, dwellTooShort } = validation.data;

  // Honeypot / dwell-time failures: respond with a fabricated-looking
  // success so retrying bots gain nothing, but write nothing to the
  // database. This only filters naive bots -- not a real security
  // boundary, and the rate limit + advisory lock inside the RPC are what
  // actually matter.
  if (honeypotFilled || dwellTooShort) {
    res.status(201).json({ ok: true, reference: 'PENDING', date, time: null, partySize });
    return;
  }

  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const userAgent = typeof req.headers['user-agent'] === 'string'
    ? req.headers['user-agent'].slice(0, 300)
    : null;

  const { data, error } = await supabase.rpc('create_reservation', {
    p_date: date,
    p_slot_minute: slotMinute,
    p_party_size: partySize,
    p_name: name,
    p_phone: phone,
    p_email: email,
    p_notes: notes,
    p_ip_hash: ipHash,
    p_user_agent: userAgent
  });

  if (error) {
    res.status(500).json({ ok: false, code: 'server_error' });
    return;
  }

  if (!data.ok) {
    const status = RPC_ERROR_STATUS[data.code] || 400;
    if (status === 429) {
      res.setHeader('Retry-After', '3600');
    }
    res.status(status).json({ ok: false, code: data.code });
    return;
  }

  const hours = Math.floor(data.slotMinute / 60);
  const minutes = data.slotMinute % 60;
  const time = String(hours % 24).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');

  res.status(201).json({
    ok: true,
    reference: data.reference,
    date: data.date,
    time,
    partySize
  });
};
