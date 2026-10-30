// Shared request validation for the reservation API. Rejecting here means
// the database and its RPCs never see malformed input -- this is a fast,
// cheap first layer; the authoritative rules (open hours, capacity, closed
// dates, lead time) are enforced again inside create_reservation itself.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^[+0-9 ()\-.]{7,24}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVATION_STATUSES = ['booked', 'seated', 'no_show', 'cancelled'];
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F]/g;

function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function stripControlChars(value) {
  return value.replace(CONTROL_CHARS_RE, '');
}

// Validates a date=YYYY-MM-DD query param. Returns { ok, date } or
// { ok: false, code }.
function validateDateParam(value) {
  if (!isValidDateString(value)) {
    return { ok: false, code: 'invalid_date' };
  }
  return { ok: true, date: value };
}

// Validates a POST /api/reservations body. Returns { ok, data } with a
// cleaned-up copy of the fields, or { ok: false, code }.
function validateReservationBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'invalid_body' };
  }

  if (!isValidDateString(body.date)) {
    return { ok: false, code: 'invalid_date' };
  }

  const slotMinute = Number(body.slotMinute);
  if (!Number.isInteger(slotMinute) || slotMinute < 0 || slotMinute > 1680) {
    return { ok: false, code: 'invalid_slot' };
  }

  const partySize = Number(body.partySize);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) {
    return { ok: false, code: 'party_size_out_of_range' };
  }

  const name = typeof body.name === 'string' ? stripControlChars(body.name).trim() : '';
  if (name.length < 2 || name.length > 80) {
    return { ok: false, code: 'invalid_name' };
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!PHONE_RE.test(phone)) {
    return { ok: false, code: 'invalid_phone' };
  }

  let email = null;
  if (typeof body.email === 'string' && body.email.trim() !== '') {
    const trimmedEmail = body.email.trim();
    if (trimmedEmail.length > 120 || !EMAIL_RE.test(trimmedEmail)) {
      return { ok: false, code: 'invalid_email' };
    }
    email = trimmedEmail;
  }

  let notes = null;
  if (typeof body.notes === 'string' && body.notes.trim() !== '') {
    const cleanedNotes = stripControlChars(body.notes).trim();
    if (cleanedNotes.length > 500) {
      return { ok: false, code: 'invalid_notes' };
    }
    notes = cleanedNotes;
  }

  // Honeypot: a real visitor never fills this field. Non-empty means a bot.
  const honeypotFilled = typeof body.company === 'string' && body.company.trim() !== '';

  // Dwell time: time between the form becoming visible and submit. Easily
  // forged, so this only filters naive scripts -- it is a speed bump, not a
  // security control.
  const elapsedMs = Number(body.elapsedMs);
  const dwellTooShort = !Number.isFinite(elapsedMs) || elapsedMs < 2500;

  return {
    ok: true,
    data: {
      date: body.date,
      slotMinute,
      partySize,
      name,
      phone,
      email,
      notes,
      honeypotFilled,
      dwellTooShort
    }
  };
}

// Validates a POST /api/reservation-status body: { id, status }. Returns
// { ok, data: { id, status } } or { ok: false, code }.
function validateStatusUpdateBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'invalid_body' };
  }

  if (typeof body.id !== 'string' || !UUID_RE.test(body.id)) {
    return { ok: false, code: 'invalid_id' };
  }

  if (typeof body.status !== 'string' || RESERVATION_STATUSES.indexOf(body.status) === -1) {
    return { ok: false, code: 'invalid_status' };
  }

  return { ok: true, data: { id: body.id, status: body.status } };
}

module.exports = { validateDateParam, validateReservationBody, validateStatusUpdateBody };
