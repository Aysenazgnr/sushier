// Hashes the requester's IP for rate limiting. The raw IP is never stored
// or logged -- only sha256(ip + server salt) reaches the database, which
// is enough to count "bookings from this visitor today" without keeping a
// reversible personal network identifier.
const crypto = require('crypto');

function getClientIp(req) {
  // Vercel sets x-forwarded-for at the edge and strips client-supplied
  // values, so the first entry is trustworthy there.
  const header = req.headers['x-forwarded-for'];
  if (typeof header === 'string' && header.length > 0) {
    return header.split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT || '';
  return crypto.createHash('sha256').update(ip + ':' + salt).digest('hex');
}

module.exports = { getClientIp, hashIp };
