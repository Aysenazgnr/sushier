// GET /api/availability?date=YYYY-MM-DD
// Read-only: returns the slot grid and remaining-table counts for one
// date. No CORS headers are emitted -- the site and this API share an
// origin, so the browser never preflights and there is no ACAO to get
// wrong. No rate limit beyond the platform: worst case someone enumerates
// the calendar, which only reveals how busy the restaurant is.
const { supabase } = require('./_lib/supabase');
const { validateDateParam } = require('./_lib/validate');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ ok: false, code: 'method_not_allowed' });
    return;
  }

  const dateResult = validateDateParam(req.query.date);
  if (!dateResult.ok) {
    res.status(400).json({ ok: false, code: dateResult.code });
    return;
  }

  const { data, error } = await supabase.rpc('get_availability', { p_date: dateResult.date });

  if (error) {
    res.status(500).json({ ok: false, code: 'server_error' });
    return;
  }

  res.status(200).json(data);
};
