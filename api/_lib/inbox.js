// Reads the restaurant's Gmail inbox over IMAP for the daily digest
// (api/cron-digest.js). Optional by design, same contract as every other
// integration helper in api/_lib: a missing env var must never throw at
// import time (a missing IMAP_* here must only break the digest cron,
// nothing else on the site), every failure is caught and logged under
// the [inbox] tag (never the password), and the mailbox is opened
// read-only so this feature can never mark mail as read, move it, or
// delete it -- only look.
//
// Gmail over its own REST API was considered and rejected: the
// `gmail.readonly` scope Google requires for a date-filtered search is a
// "restricted scope" that needs Google's app-verification review before
// an OAuth client can leave "Testing" status, and a client left in
// Testing has its refresh tokens expire every 7 days -- a cron that
// quietly stops working every week is worse than one extra dependency.
// IMAP + an app password has no such expiry.
const { ImapFlow } = require('imapflow');

const HOST = process.env.IMAP_HOST || '';
const PORT = Number(process.env.IMAP_PORT) || 993;
const USER = process.env.IMAP_USER || '';
const APP_PASSWORD = process.env.IMAP_APP_PASSWORD || '';
const CONNECT_TIMEOUT_MS = 10000;
const MAX_MESSAGES = 30;
const SNIPPET_CHARS = 400;

function isConfigured() {
  return HOST !== '' && USER !== '' && APP_PASSWORD !== '';
}

// Pulls the plain-text snippet out of a message's body structure without
// downloading anything else. bodyPart() returns a node like { part: '1',
// type: 'text/plain', ... } or null if the message has no plain-text
// part at all (e.g. an HTML-only marketing email) -- callers must treat
// that as "no snippet available", not as an error.
function findPlainTextPart(bodyStructure) {
  if (!bodyStructure) return null;
  if (bodyStructure.type === 'text/plain') return bodyStructure;
  if (Array.isArray(bodyStructure.childNodes)) {
    for (const child of bodyStructure.childNodes) {
      const found = findPlainTextPart(child);
      if (found) return found;
    }
  }
  return null;
}

// Returns { ok:true, messages } where each message is
// { from, subject, date, snippet } -- never the full body, never written
// anywhere but passed in memory to api/_lib/digest.js -- or
// { ok:false, code } on any connection/auth failure. Never throws.
async function fetchRecentInboxSummaries(sinceMs) {
  if (!isConfigured()) {
    console.error('[inbox] not configured: IMAP_HOST, IMAP_USER or IMAP_APP_PASSWORD missing');
    return { ok: false, code: 'inbox_not_configured' };
  }

  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user: USER, pass: APP_PASSWORD },
    // The default logger writes every IMAP command (including subject
    // lines fetched) to stdout, which would land in Vercel's runtime
    // logs. This feature's whole point is to keep inbox content out of
    // logs, so logging is disabled outright.
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS
  });

  const messages = [];
  try {
    await client.connect();
    // readOnly: true means no \Seen flag is ever set and nothing can be
    // moved or deleted through this connection, even by a bug here.
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const since = new Date(sinceMs);
      let count = 0;
      for await (const message of client.fetch(
        { since },
        { envelope: true, bodyStructure: true }
      )) {
        if (count >= MAX_MESSAGES) break;

        const fromAddr = message.envelope.from && message.envelope.from[0];
        const fromText = fromAddr ? (fromAddr.name || fromAddr.address || '') : '';
        // Mail this inbox itself sent (e.g. auto-replies, CC'd copies of
        // the restaurant's own outgoing mail) isn't "mail that came in"
        // for the purposes of a digest of what needs attention.
        if (fromAddr && fromAddr.address && fromAddr.address.toLowerCase() === USER.toLowerCase()) {
          continue;
        }

        const plainPart = findPlainTextPart(message.bodyStructure);
        let snippet = '';
        if (plainPart) {
          // Download only this one small part, not the whole message.
          const { content } = await client.download(message.uid, plainPart.part, { uid: true });
          const text = await streamToString(content, SNIPPET_CHARS);
          snippet = text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
        }

        messages.push({
          from: fromText,
          subject: message.envelope.subject || '(konusuz)',
          date: message.envelope.date ? message.envelope.date.toISOString() : null,
          snippet // '' when the message has no plain-text part -- digest.js treats that as "no preview", not an error
        });
        count++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, messages };
  } catch (err) {
    console.error('[inbox] fetch failed:', err && err.name, err && err.message);
    try {
      await client.logout();
    } catch (_) {
      // Already disconnected or never connected -- nothing to clean up.
    }
    return { ok: false, code: 'inbox_fetch_failed' };
  }
}

// Reads a Node stream into a string, stopping once maxChars worth of
// bytes have arrived -- a snippet never needs more than that, and this
// avoids buffering an attachment-sized plain-text part in full.
function streamToString(stream, maxChars) {
  return new Promise((resolve, reject) => {
    let result = '';
    stream.on('data', (chunk) => {
      if (result.length < maxChars) result += chunk.toString('utf8');
    });
    stream.on('end', () => resolve(result));
    stream.on('error', reject);
  });
}

module.exports = { isConfigured, fetchRecentInboxSummaries };
