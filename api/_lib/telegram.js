// Telegram notifications for new reservations and staff cancellations.
// Optional by design -- unlike api/_lib/supabase.js, a missing token here
// must never throw at import time, because that would take down the whole
// booking/cancellation flow over a notification feature. Every public
// function swallows its own failures (network error, bad token, Telegram
// outage) so the caller's real work (the booking, the cancellation) always
// completes regardless of whether the message gets through.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SEND_TIMEOUT_MS = 3000;

// Guest-supplied text (name, notes) must never be interpolated into the
// HTML-parsed message unescaped -- same defense as js/admin.js rendering
// guest fields via textContent, just applied to Telegram's parse_mode:
// 'HTML' instead of the DOM.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
  } catch (err) {
    // Swallowed on purpose -- see file header. Nothing to retry; the next
    // reservation/cancellation will try again on its own.
  }
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

module.exports = { notifyNewReservation, notifyCancellation };
