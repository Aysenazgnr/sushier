// Resend wrapper for guest/staff-facing email: the new-reservation alert
// to the restaurant (api/reservations.js) and guest reminder mails
// (api/cron-reminders.js). Optional by design, same contract as
// api/_lib/telegram.js: a missing key must never throw at import time,
// because that would take down booking over an email feature. Every
// public function swallows its own failures and logs them (never the
// API key) so a silent delivery failure is still observable.
const { renderNewReservationAlert } = require('./mail-templates');

const API_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.MAIL_FROM || ''; // e.g. "Sushier <rezervasyon@sushier.com>"
const ALERT_TO = process.env.MAIL_ALERT_TO || '';
const SEND_TIMEOUT_MS = 3000;
const SEND_URL = 'https://api.resend.com/emails';
const BATCH_URL = 'https://api.resend.com/emails/batch';
// Resend batch accepts at most 100 messages per call (see docs).
const BATCH_MAX = 100;

function isConfigured() {
  return API_KEY !== '' && FROM !== '';
}

function alertConfigured() {
  return isConfigured() && ALERT_TO !== '';
}

// params: { to, subject, html, text, replyTo }. Never throws -- logs and
// returns on any failure, same as telegram.js's sendMessage.
async function send(params) {
  if (!isConfigured()) {
    console.error('[mail] not configured: RESEND_API_KEY or MAIL_FROM missing');
    return;
  }

  const payload = {
    from: FROM,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text
  };
  if (params.replyTo) payload.reply_to = params.replyTo;

  try {
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + API_KEY
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[mail] Resend rejected the message:', res.status, body);
    }
  } catch (err) {
    console.error('[mail] send failed:', err && err.name, err && err.message);
  }
}

// messages: array of { to, subject, html, text, replyTo }, up to 100.
// Used by api/cron-reminders.js to send many reminders in one request
// instead of one fetch per guest (Resend's default rate limit is 10
// requests/second per team, so a batch is both faster and safer here).
// An Idempotency-Key is attached so a GitHub Actions retry of the same
// cron run cannot double-send the same batch of reminders; the key is
// derived from the exact set of reservation references being sent, so a
// *different* batch (different references) always gets its own key.
// Returns { ok:true, ids } on success (ids line up with the input
// order, per Resend's batch response) or { ok:false } on any failure --
// never throws, same contract as send().
async function sendBatch(messages, idempotencyKey) {
  if (!isConfigured() || messages.length === 0) {
    if (!isConfigured()) console.error('[mail] not configured: RESEND_API_KEY or MAIL_FROM missing');
    return { ok: false, ids: [] };
  }
  if (messages.length > BATCH_MAX) {
    console.error('[mail] sendBatch called with', messages.length, 'messages, max is', BATCH_MAX);
    return { ok: false, ids: [] };
  }

  const payload = messages.map((m) => {
    const entry = { from: FROM, to: m.to, subject: m.subject, html: m.html, text: m.text };
    if (m.replyTo) entry.reply_to = m.replyTo;
    return entry;
  });

  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + API_KEY
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  try {
    const res = await fetch(BATCH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[mail] Resend rejected the batch:', res.status, body);
      return { ok: false, ids: [] };
    }
    const body = await res.json();
    return { ok: true, ids: (body.data || []).map((d) => d.id) };
  } catch (err) {
    console.error('[mail] batch send failed:', err && err.name, err && err.message);
    return { ok: false, ids: [] };
  }
}

// Called only from the genuine success path in api/reservations.js --
// mirrors notifyNewReservation in api/_lib/telegram.js, just as an email
// to the restaurant's own notification address instead of a Telegram
// chat. Silently does nothing if MAIL_ALERT_TO isn't set -- this feature
// is opt-in on top of mail being configured at all.
async function sendNewReservationAlert(booking) {
  if (!alertConfigured()) return;

  const { subject, html, text } = renderNewReservationAlert(booking);
  await send({
    to: ALERT_TO,
    subject,
    html,
    text,
    replyTo: booking.email || undefined
  });
}

module.exports = { isConfigured, alertConfigured, send, sendBatch, sendNewReservationAlert };
