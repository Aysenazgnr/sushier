// Telegram notifications for new reservations, staff cancellations, and
// the daily inbox digest.
// Optional by design -- unlike api/_lib/supabase.js, a missing token here
// must never throw at import time, because that would take down the whole
// booking/cancellation flow over a notification feature. Every public
// function swallows its own failures (network error, bad token, Telegram
// outage) so the caller's real work (the booking, the cancellation, the
// digest) always completes regardless of whether the message gets through.
const { escapeHtml } = require('./html');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEND_TIMEOUT_MS = 3000;

// Telegram's real limit is 4096 characters; this leaves headroom for
// HTML entities (escapeHtml can expand a character to &lt; etc.) pushing
// a message that measured just under the limit back over it.
const MAX_MESSAGE_CHARS = 3500;

async function sendMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('[telegram] not configured: token or chat id missing');
    return;
  }

  try {
    const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!res.ok) {
      // Logged (status + Telegram's own error description only, never the
      // token or chat id) so a silent delivery failure in production is
      // actually observable instead of a guest/staff action just not
      // notifying with no trace anywhere.
      const body = await res.text().catch(() => '');
      console.error('[telegram] API rejected the message:', res.status, body);
    }
  } catch (err) {
    // Network error, timeout, etc. -- still swallowed (see file header:
    // the caller's real work must never fail over this), but logged so
    // outages are visible in Vercel's runtime logs.
    console.error('[telegram] send failed:', err && err.name, err && err.message);
  }
}

// Splits text that may be longer than Telegram's message limit into
// chunks that break on line boundaries where possible, so one logical
// digest entry isn't cut in half mid-sentence. Pure function, easy to
// unit-test independent of the network call below.
function chunkMessage(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_CHARS) {
    let cut = rest.lastIndexOf('\n', MAX_MESSAGE_CHARS);
    if (cut <= 0) cut = MAX_MESSAGE_CHARS; // no newline to break on -- hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function formatBookingLines(booking) {
  const lines = [
    booking.date + ' — ' + booking.time + ', ' + booking.partySize + ' kişi',
    '<b>' + escapeHtml(booking.name) + '</b>',
    escapeHtml(booking.phone)
  ];
  if (booking.email) lines.push(escapeHtml(booking.email));
  if (booking.notes) lines.push('Not: ' + escapeHtml(booking.notes));
  lines.push('Referans: <code>' + escapeHtml(booking.reference) + '</code>');
  return lines;
}

// Called only from the genuine success path in api/reservations.js --
// never from the honeypot/dwell-time fake-success branch, which writes
// nothing to the database and must stay silent here too.
async function notifyNewReservation(booking) {
  const lines = ['🍱 <b>Yeni rezervasyon</b>', ''].concat(formatBookingLines(booking));
  await sendMessage(lines.join('\n'));
}

// Called only when a staff action sets status to 'cancelled' (see
// api/reservation-status.js). Seated / no-show / reopen stay silent --
// routine operations, not something worth a push notification for.
async function notifyCancellation(booking, staffEmail) {
  const lines = ['❌ <b>İptal edildi</b>', ''].concat(formatBookingLines(booking));
  lines.push('');
  lines.push('İptal eden: ' + escapeHtml(staffEmail || 'bilinmiyor'));
  await sendMessage(lines.join('\n'));
}

// Called once a day from api/cron-digest.js with the already-rendered
// digest text (see api/_lib/digest.js -- this function never builds the
// text itself, it only has to get a long message delivered). Chunked and
// sent in order; one chunk failing (logged inside sendMessage) does not
// stop the rest from being tried, since each is an independent request.
async function notifyDigest(text) {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    await sendMessage(chunk);
  }
}

module.exports = { notifyNewReservation, notifyCancellation, notifyDigest };
