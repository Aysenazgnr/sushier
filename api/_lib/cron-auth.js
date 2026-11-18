// Shared bearer-token check for the two cron endpoints (api/cron-reminders.js,
// api/cron-digest.js), both called by GitHub Actions rather than a browser.
// Unlike api/reservation-status.js's staff Bearer token (a real Supabase
// session, verified against auth.getUser()), this is a single shared
// secret -- there is no user identity on the other end, just a scheduled
// workflow run. crypto.timingSafeEqual avoids leaking the secret's length
// or contents through response-timing differences.
const crypto = require('crypto');

const CRON_SECRET = process.env.CRON_SECRET || '';

// Returns true only if CRON_SECRET is configured and the request's
// Authorization: Bearer <token> header matches it exactly. A missing
// CRON_SECRET always fails closed (never "open" just because it's unset)
// -- these endpoints touch the guest email list and (indirectly) the
// Anthropic API, so an unconfigured secret must not mean "anyone can call
// this", unlike the optional-integration helpers elsewhere in api/_lib.
function isAuthorizedCronRequest(req) {
  if (!CRON_SECRET) return false;

  const header = req.headers['authorization'] || '';
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : '';
  if (!token) return false;

  const expected = Buffer.from(CRON_SECRET);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { isAuthorizedCronRequest };
