// Shared HTML-escaping for anywhere guest-supplied text (name, notes,
// email, staff email) is interpolated into a limited HTML renderer --
// Telegram's parse_mode: 'HTML' and the mail templates' own inline HTML.
// Neither renderer gets a real DOM to lean on (unlike js/admin.js, which
// renders guest fields via textContent), so this is the actual defense.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { escapeHtml };
