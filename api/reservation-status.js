// POST /api/reservation-status
// Lets staff change a reservation's status (seated / no_show / cancelled /
// reopened-to-booked) instead of js/admin.js writing to Supabase directly.
// This is NOT a tighter authorization boundary -- the update still runs
// under the calling staff member's own session, so Postgres RLS
// (is_staff(), see supabase/migrations/0003_staff_and_rls.sql) decides
// exactly as it did before. This route exists only so a cancellation can
// trigger a Telegram notification, which no client-side code could do
// without shipping the bot token to the browser.
const { createClient } = require('@supabase/supabase-js');
const { validateStatusUpdateBody } = require('./_lib/validate');
const { notifyCancellation } = require('./_lib/telegram');

const MAX_BODY_BYTES = 2 * 1024;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.status(500).json({ ok: false, code: 'server_error' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.indexOf('Bearer ') === 0 ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
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

  const validation = validateStatusUpdateBody(req.body);
  if (!validation.ok) {
    res.status(400).json({ ok: false, code: validation.code });
    return;
  }
  const { id, status } = validation.data;

  // Scoped to the caller's own session, not the service-role key used in
  // api/_lib/supabase.js -- every query below runs as this staff member,
  // so RLS is the real gate and this route has no elevated access of its
  // own.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: 'Bearer ' + token } }
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) {
    res.status(401).json({ ok: false, code: 'unauthorized' });
    return;
  }
  const staffEmail = userData.user.email || null;
  const staffId = userData.user.id;

  const patch = { status: status, updated_by: staffId };
  if (status === 'cancelled') {
    patch.cancelled_at = new Date().toISOString();
  } else if (status === 'booked') {
    // Reopen path (from cancelled, seated or no_show), matching the
    // behavior js/admin.js used to apply directly.
    patch.cancelled_at = null;
  }

  const { data: row, error: updateError } = await userClient
    .from('reservations')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle();

  if (updateError) {
    res.status(500).json({ ok: false, code: 'server_error' });
    return;
  }

  // RLS returns zero rows rather than an error for a caller who isn't
  // staff. That denial and "no such reservation" are indistinguishable on
  // purpose here, same spirit as the one generic sign-in failure message
  // in js/admin.js.
  if (!row) {
    res.status(403).json({ ok: false, code: 'forbidden' });
    return;
  }

  // Only cancellation gets a push notification -- seated / no-show / reopen
  // are routine operations, not something worth interrupting staff for.
  if (status === 'cancelled') {
    await notifyCancellation({
      date: row.service_date,
      time: minutesToTime(row.slot_minute),
      partySize: row.party_size,
      name: row.guest_name,
      phone: row.guest_phone,
      email: row.guest_email,
      notes: row.notes,
      reference: row.reference
    }, staffEmail);
  }

  res.status(200).json({ ok: true, reservation: row });
};
