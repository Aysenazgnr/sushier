// Module-scope client, reused across warm serverless invocations. Uses the
// service_role key, which bypasses RLS entirely -- this is correct and
// expected here: these two API functions (availability, reservations) are
// the only code holding this key, and both validate every request before
// touching the database. If either env var is missing this throws at
// import time, so every request fails loudly with a 500 instead of the
// client silently talking to nothing.
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = { supabase };
