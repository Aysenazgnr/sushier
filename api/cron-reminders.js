// POST /api/cron-reminders
// Called hourly by .github/workflows/cron-reminders.yml (not by any
// browser) -- Vercel's Hobby plan only runs its own crons once a day, so
// this hourly trigger lives in GitHub Actions instead; see that workflow
// file and docs/mail-otomasyonu.md for why.
//
// Sends a reminder email to every guest whose reservation starts 2-4
// hours from now, who gave an email address, and hasn't been reminded
// yet. The 2-4 hour window (not exactly "3 hours") absorbs a few minutes
// of scheduler jitter and an occasional missed/delayed run without
// either double-sending or dropping a reminder -- each reservation sits
// in the window across roughly two hourly runs.
const crypto = require('crypto');
const { supabase } = require('./_lib/supabase');
const { isAuthorizedCronRequest } = require('./_lib/cron-auth');
const { sendBatch } = require('./_lib/mail');
const { renderGuestReminder } = require('./_lib/mail-templates');

const WINDOW_START_MS = 2 * 60 * 60 * 1000;
const WINDOW_END_MS = 4 * 60 * 60 * 1000;

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, code: 'method_not_allowed' });
    return;
  }

  if (!isAuthorizedCronRequest(req)) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
    return;
  }

  const now = Date.now();
  const windowStart = new Date(now + WINDOW_START_MS).toISOString();
  const windowEnd = new Date(now + WINDOW_END_MS).toISOString();
  const claimedAt = new Date(now).toISOString();

  // Atomic claim: a single UPDATE ... RETURNING. Two overlapping cron
  // runs (a slow one still finishing when the next hour's run starts)
  // can't both claim the same reservation -- Postgres serializes the two
  // UPDATEs, and whichever runs second sees reminder_sent_at already set
  // and its WHERE clause simply matches zero rows for that reservation.
  // This is deliberately claim-first-send-after: if Resend is down for
  // this run, these rows are marked sent anyway and will NOT be retried
  // next hour. For a reservation reminder, "occasionally missing one" is
  // a smaller problem than "occasionally sending the same guest two".
  const { data: claimed, error: claimError } = await supabase
    .from('reservations')
    .update({ reminder_sent_at: claimedAt })
    .is('reminder_sent_at', null)
    .eq('status', 'booked')
    .not('guest_email', 'is', null)
    .gte('starts_at', windowStart)
    .lte('starts_at', windowEnd)
    .select();

  if (claimError) {
    console.error('[cron-reminders] claim query failed:', claimError.message);
    res.status(500).json({ ok: false, code: 'server_error' });
    return;
  }

  const reservations = claimed || [];
  if (reservations.length === 0) {
    res.status(200).json({ ok: true, claimed: 0, sent: 0 });
    return;
  }

  const messages = reservations.map((row) => {
    const booking = {
      date: row.service_date,
      time: minutesToTime(row.slot_minute),
      partySize: row.party_size,
      name: row.guest_name,
      phone: row.guest_phone,
      notes: row.notes,
      reference: row.reference
    };
    const { subject, html, text } = renderGuestReminder(booking);
    return { to: row.guest_email, subject, html, text };
  });

  // Idempotency key is derived from the exact set of reservation
  // references in this batch -- a retried GitHub Actions step that
  // re-POSTs with the *same* claimed rows (unlikely, since claiming
  // already happened, but this is a second independent safety net) gets
  // deduplicated by Resend; a different set of rows always gets a fresh
  // key and is never blocked by this. Hashed rather than joined directly
  // because Resend caps idempotency keys at 256 characters and a full
  // batch of 100 references would exceed that.
  const referenceDigest = crypto
    .createHash('sha256')
    .update(reservations.map((r) => r.reference).sort().join(','))
    .digest('hex');
  const idempotencyKey = 'reminders:' + referenceDigest;
  const result = await sendBatch(messages, idempotencyKey);

  res.status(200).json({
    ok: true,
    claimed: reservations.length,
    sent: result.ok ? result.ids.length : 0,
    failed: result.ok ? 0 : reservations.length
  });
};
