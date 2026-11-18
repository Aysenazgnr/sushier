// Turns raw inbox summaries (api/_lib/inbox.js) into the Telegram text
// api/cron-digest.js sends. Claude is asked for structured JSON, never
// for HTML or Markdown -- Telegram's parse_mode: 'HTML' only understands
// a small tag subset (https://core.telegram.org/bots/api#html-style),
// and letting the model freely emit HTML risks an unparseable message
// that Telegram just rejects outright. We render the HTML ourselves from
// plain fields instead, escaping every one of them exactly like
// api/_lib/telegram.js already does for guest-supplied text.
const { escapeHtml } = require('./html');
const { createMessage, isConfigured: anthropicConfigured } = require('./anthropic');

const DIGEST_MAX_TOKENS = 1500;
const IMPORTANCE_LABEL = { yuksek: '🔴 Yüksek', orta: '🟡 Orta', dusuk: '⚪ Düşük' };
const IMPORTANCE_ORDER = { yuksek: 0, orta: 1, dusuk: 2 };

const SYSTEM_PROMPT = `
Sana bir restoranın son 24 saatte gelen kutusuna düşen maillerin listesi (gönderen, konu, tarih, kısa önizleme) verilecek. Görevin bunları önem sırasına göre sınıflandırmak ve kısaca özetlemek.

Önem ölçütleri:
- yuksek: rezervasyon talebi/değişikliği, iptal, şikayet, basın/medya talebi, tedarikçi faturası veya ödeme uyarısı, yasal/resmi kurum maili.
- orta: iş teklifi, iş başvurusu, genel soru, kurye/lojistik bildirimi.
- dusuk: bülten, reklam, otomatik bildirim, spam görünümlü mail.

Yalnızca şu JSON şemasıyla cevap ver, başka hiçbir metin ekleme:
{"overview": "günün bir cümlelik özeti", "items": [{"importance": "yuksek|orta|dusuk", "from": "...", "subject": "...", "summary": "tek cümlelik özet", "action": "gerekiyorsa yapılacak iş, yoksa boş string"}]}
`.trim();

function buildUserMessage(messages) {
  const lines = messages.map((m, i) => {
    return (
      (i + 1) + '. Gönderen: ' + m.from +
      ' | Konu: ' + m.subject +
      ' | Tarih: ' + (m.date || 'bilinmiyor') +
      ' | Önizleme: ' + (m.snippet || '(önizleme yok)')
    );
  });
  return 'Son 24 saatteki mailler:\n' + lines.join('\n');
}

function tryParseDigestJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

// Renders the escaped Telegram-HTML text for a successfully ranked
// digest. Every model-produced string is treated as untrusted content
// and escaped, exactly like guest-supplied fields elsewhere.
function renderRankedDigest(parsed, totalCount) {
  const items = parsed.items
    .slice()
    .sort((a, b) => (IMPORTANCE_ORDER[a.importance] ?? 9) - (IMPORTANCE_ORDER[b.importance] ?? 9));

  const lines = ['📬 <b>Günlük mail özeti</b> (' + totalCount + ' mail)', ''];
  if (parsed.overview) lines.push(escapeHtml(parsed.overview), '');

  for (const item of items) {
    const label = IMPORTANCE_LABEL[item.importance] || '⚪';
    lines.push(label + ' <b>' + escapeHtml(item.subject || '(konusuz)') + '</b>');
    lines.push(escapeHtml(item.from || ''));
    if (item.summary) lines.push(escapeHtml(item.summary));
    if (item.action) lines.push('→ ' + escapeHtml(item.action));
    lines.push('');
  }
  return lines.join('\n').trim();
}

// Fallback used whenever Claude is unavailable or returns something we
// can't parse: an unranked, un-summarized but still useful list straight
// from the inbox data. Staying silent on a digest failure would be worse
// than sending a plain list, so this always has something to send.
function renderRawDigest(messages) {
  const lines = ['📬 <b>Günlük mail özeti</b> (' + messages.length + ' mail)', '⚠️ Otomatik özet çıkarılamadı, ham liste:', ''];
  for (const m of messages) {
    lines.push('• <b>' + escapeHtml(m.subject) + '</b> — ' + escapeHtml(m.from));
  }
  return lines.join('\n').trim();
}

// Returns the final Telegram-ready text for an inbox that had at least
// one message. Never throws -- any Claude failure falls back to
// renderRawDigest rather than propagating an error to the caller.
async function buildDigestText(messages) {
  if (!anthropicConfigured()) {
    console.error('[digest] Anthropic not configured, sending raw list');
    return renderRawDigest(messages);
  }

  const result = await createMessage({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(messages) }],
    maxTokens: DIGEST_MAX_TOKENS
  });

  if (!result.ok) {
    console.error('[digest] Claude call failed:', result.code);
    return renderRawDigest(messages);
  }

  const textBlock = (result.message.content || []).find((b) => b.type === 'text');
  const parsed = textBlock ? tryParseDigestJson(textBlock.text) : null;
  if (!parsed) {
    console.error('[digest] could not parse Claude response as the expected JSON shape');
    return renderRawDigest(messages);
  }

  return renderRankedDigest(parsed, messages.length);
}

module.exports = { buildDigestText };
