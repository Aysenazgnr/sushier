// POST /api/cron-digest
// Called once a day at 09:00 Europe/Istanbul by .github/workflows/cron-digest.yml
// (not by any browser) -- see that workflow and docs/mail-otomasyonu.md
// for why this lives in GitHub Actions rather than Vercel's own cron.
//
// Reads the last 24 hours of the restaurant's inbox (api/_lib/inbox.js,
// IMAP, read-only), has Claude rank and summarize it
// (api/_lib/digest.js), and posts the result to the existing Telegram
// chat (api/_lib/telegram.js's notifyDigest). Every step degrades to a
// visible message rather than silence: no mail -> a short "nothing came
// in" note; IMAP failure -> a warning note + 502 so the GitHub Actions
// run shows red; Claude failure -> an unranked raw list (handled inside
// digest.js) rather than no digest at all.
const { isAuthorizedCronRequest } = require('./_lib/cron-auth');
const { fetchRecentInboxSummaries } = require('./_lib/inbox');
const { buildDigestText } = require('./_lib/digest');
const { notifyDigest } = require('./_lib/telegram');

const LOOKBACK_MS = 24 * 60 * 60 * 1000;

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

  const inbox = await fetchRecentInboxSummaries(Date.now() - LOOKBACK_MS);
  if (!inbox.ok) {
    // Sent so a broken mailbox connection doesn't just silently stop
    // showing up every morning with nobody noticing -- see file header.
    await notifyDigest('⚠️ <b>Gelen kutusu özeti alınamadı.</b> IMAP bağlantısı başarısız oldu, lütfen ayarları kontrol edin.');
    res.status(502).json({ ok: false, code: inbox.code });
    return;
  }

  if (inbox.messages.length === 0) {
    await notifyDigest('📭 Son 24 saatte yeni mail yok.');
    res.status(200).json({ ok: true, messageCount: 0 });
    return;
  }

  const digestText = await buildDigestText(inbox.messages);
  await notifyDigest(digestText);

  res.status(200).json({ ok: true, messageCount: inbox.messages.length });
};
