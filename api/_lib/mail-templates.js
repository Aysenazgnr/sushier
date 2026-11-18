// Turkish HTML + plain-text email bodies. Kept separate from api/_lib/mail.js
// so the sending mechanics (fetch, retries, batching) don't get tangled up
// with markup. Every guest-supplied field (guest_name, notes, phone, email)
// is escaped with escapeHtml before going into the HTML body -- same
// defense api/_lib/telegram.js applies for its own parse_mode: 'HTML'
// messages, here applied to an actual email client's renderer instead.
const { escapeHtml } = require('./html');

const RESTAURANT_NAME = 'Sushier';
const RESTAURANT_PHONE = '+90 000 000 00 00';
const RESTAURANT_EMAIL = 'reservations@sushier.com';

// Minimal inline-CSS wrapper shared by both templates -- email clients
// strip <style> blocks unpredictably, so every rule that matters is
// inline on the element itself.
function wrapHtml(title, bodyHtml) {
  return (
    '<!doctype html><html lang="tr"><head><meta charset="utf-8">' +
    '<title>' + escapeHtml(title) + '</title></head>' +
    '<body style="margin:0;padding:24px;background:#f6f3ef;font-family:Georgia,\'Times New Roman\',serif;color:#2a2420;">' +
    '<div style="max-width:480px;margin:0 auto;background:#fffdfb;border:1px solid #e6ddd3;border-radius:8px;padding:28px;">' +
    '<h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#2a2420;">' + escapeHtml(RESTAURANT_NAME) + '</h1>' +
    bodyHtml +
    '<p style="margin:24px 0 0;font-size:12px;color:#8a8077;">' + escapeHtml(RESTAURANT_PHONE) + ' · ' + escapeHtml(RESTAURANT_EMAIL) + '</p>' +
    '</div></body></html>'
  );
}

function bookingFactsHtml(booking) {
  const rows = [
    ['Tarih', booking.date],
    ['Saat', booking.time],
    ['Kişi sayısı', String(booking.partySize) + ' kişi'],
    ['Ad Soyad', booking.name],
    ['Telefon', booking.phone]
  ];
  if (booking.notes) rows.push(['Not', booking.notes]);
  rows.push(['Referans', booking.reference]);

  return (
    '<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">' +
    rows
      .map(
        ([label, value]) =>
          '<tr><td style="padding:4px 8px 4px 0;color:#8a8077;white-space:nowrap;">' +
          escapeHtml(label) +
          '</td><td style="padding:4px 0;color:#2a2420;">' +
          escapeHtml(value) +
          '</td></tr>'
      )
      .join('') +
    '</table>'
  );
}

function bookingFactsText(booking) {
  const lines = [
    'Tarih: ' + booking.date,
    'Saat: ' + booking.time,
    'Kişi sayısı: ' + booking.partySize + ' kişi',
    'Ad Soyad: ' + booking.name,
    'Telefon: ' + booking.phone
  ];
  if (booking.notes) lines.push('Not: ' + booking.notes);
  lines.push('Referans: ' + booking.reference);
  return lines.join('\n');
}

// Sent to MAIL_ALERT_TO (the restaurant's own notification address) for
// every genuinely created reservation -- the email counterpart of
// notifyNewReservation in api/_lib/telegram.js. booking shape matches
// what api/reservations.js already builds for that Telegram call:
// { date, time, partySize, name, phone, email, notes, reference }.
function renderNewReservationAlert(booking) {
  const subject = 'Yeni rezervasyon — ' + booking.date + ' ' + booking.time + ' (' + booking.reference + ')';

  const emailLine = booking.email
    ? '<p style="margin:12px 0 0;font-size:13px;color:#8a8077;">Misafirin maili: ' + escapeHtml(booking.email) + '</p>'
    : '';

  const html = wrapHtml(
    subject,
    '<p style="margin:0 0 16px;font-size:14px;">Yeni bir rezervasyon alındı.</p>' +
      bookingFactsHtml(booking) +
      emailLine
  );

  const text =
    'Yeni bir rezervasyon alındı.\n\n' +
    bookingFactsText(booking) +
    (booking.email ? '\nMisafirin maili: ' + booking.email : '');

  return { subject, html, text };
}

// Sent to the guest (booking.email, which api/cron-reminders.js has
// already confirmed is non-null before calling this) roughly 2-4 hours
// before their reservation. See api/cron-reminders.js for the claim
// query that guarantees this fires at most once per reservation.
function renderGuestReminder(booking) {
  const subject = 'Hatırlatma: bugün ' + booking.time + ' rezervasyonunuz var — ' + RESTAURANT_NAME;

  const html = wrapHtml(
    subject,
    '<p style="margin:0 0 16px;font-size:14px;">Merhaba ' + escapeHtml(booking.name) + ',</p>' +
      '<p style="margin:0 0 16px;font-size:14px;">Bugünkü rezervasyonunuzu hatırlatmak istedik:</p>' +
      bookingFactsHtml(booking) +
      '<p style="margin:16px 0 0;font-size:13px;color:#8a8077;">Değişiklik veya iptal için lütfen bizi arayın: ' +
      escapeHtml(RESTAURANT_PHONE) +
      '</p>'
  );

  const text =
    'Merhaba ' + booking.name + ',\n\n' +
    'Bugünkü rezervasyonunuzu hatırlatmak istedik:\n\n' +
    bookingFactsText(booking) +
    '\n\nDeğişiklik veya iptal için lütfen bizi arayın: ' + RESTAURANT_PHONE;

  return { subject, html, text };
}

module.exports = { renderNewReservationAlert, renderGuestReminder };
