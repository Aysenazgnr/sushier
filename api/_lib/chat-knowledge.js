// Builds the system prompt for the chat widget (api/chat.js).
//
// Two sources, kept deliberately separate:
//   - STATIC_FACTS below: menu, prices, address, philosophy. These only
//     exist in index.html today (no menu table in the database) -- if the
//     menu or contact details in index.html change, update this block too.
//   - restaurant_settings row: hours, closed weekdays, party size and
//     lead-time rules. This one *is* the source of truth the rest of the
//     app already uses (api/availability.js's get_availability RPC reads
//     the same row), so it's fetched, not duplicated by hand.
//
// The settings fetch is cached for SETTINGS_TTL_MS at module scope: warm
// serverless invocations reuse it instead of hitting the database on every
// chat message, while a hall change made in /admin still reaches the bot
// within a minute. A failed fetch just falls back to the last good value
// (or null, before the first success) -- the chat still answers menu and
// contact questions even if the database is briefly unreachable.
const { supabase } = require('./supabase');

const SETTINGS_TTL_MS = 60 * 1000;
let cachedSettings = null;
let cachedAt = 0;

const STATIC_FACTS = `
Restoran: Sushier — Fine Japanese Dining (Istanbul).
Adres: 123 Harbor Lane, Istanbul, Turkey.
Telefon: +90 000 000 00 00. E-posta: reservations@sushier.com.
6 kişiden büyük gruplar için misafiri doğrudan telefon veya e-postayla iletişime yönlendir; site üzerinden bu büyüklükte rezervasyon alınmaz.

Menü (USD):
Başlangıçlar — Edamame, Yuzu Salt $9; Miso Soup $7; Tuna Tartare, Wasabi Aioli $18; Crispy Rice, Spicy Salmon $16.
Nigiri & Sashimi — Otoro, Torched $22; Hokkaido Scallop $14; Wild Salmon Sashimi (5pc) $19; Uni, Quail Egg $26.
İmza Rulolar — Dragon Tempura Roll $24; Black Pepper Wagyu Roll $28; Spicy Tuna, Crispy Garlic $21; Rainbow Roll $23.
Tatlılar — Matcha Tiramisu $12; Black Sesame Ice Cream $9; Yuzu Cheesecake $13.
Öne çıkan tabaklar — Dragon Tempura Roll $24; Chef's Omakase (yedi kurs, şefin günlük seçimi) $95; Sushier Grand Platter (masaya nigiri, sashimi ve rulo çeşitleri) $145.
`.trim();

async function fetchSettings() {
  const now = Date.now();
  if (cachedSettings && now - cachedAt < SETTINGS_TTL_MS) {
    return cachedSettings;
  }

  const { data, error } = await supabase
    .from('restaurant_settings')
    .select('timezone, open_minute, last_slot_minute, closed_weekdays, min_party_size, max_party_size, max_advance_days, min_lead_minutes')
    .eq('id', 1)
    .single();

  if (error || !data) {
    console.error('[chat-knowledge] settings fetch failed:', error && error.message);
    return cachedSettings; // stale (possibly null) is better than throwing
  }

  cachedSettings = data;
  cachedAt = now;
  return cachedSettings;
}

function minutesToClock(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

const WEEKDAY_NAMES_TR = ['', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

function describeSettings(settings) {
  if (!settings) {
    return 'Çalışma saatleri ve rezervasyon kuralları şu an alınamadı; kesin bilgi için misafiri telefonla aramaya yönlendir.';
  }
  const closedDays = (settings.closed_weekdays || []).map((d) => WEEKDAY_NAMES_TR[d]).join(', ') || 'yok';
  return [
    'Çalışma saatleri: her gün ' + minutesToClock(settings.open_minute) + '–' + minutesToClock(settings.last_slot_minute) + ' (son sipariş saati), saat dilimi ' + settings.timezone + '.',
    'Kapalı günler: ' + closedDays + '.',
    'Rezervasyon parti büyüklüğü: ' + settings.min_party_size + '–' + settings.max_party_size + ' kişi (web üzerinden).',
    'En fazla ' + settings.max_advance_days + ' gün öncesinden rezervasyon alınır, en az ' + settings.min_lead_minutes + ' dakika önceden.'
  ].join('\n');
}

async function buildSystemPrompt() {
  const settings = await fetchSettings();
  return `
Sen Sushier restoranının web sitesindeki sohbet asistanısın. Sadece Sushier hakkında (menü, saatler, adres, rezervasyon kuralları, müsaitlik) konuş; başka konulara kibarca sınır koy ve konuşmayı restorana geri getir.

Kurallar:
- Ziyaretçi hangi dilde yazarsa (Türkçe veya İngilizce) o dilde cevap ver.
- Cevapları kısa tut (2-3 cümle, gerekmedikçe madde listesi kullanma).
- Fiyat, saat veya kural iddialarını SADECE aşağıda verilen bilgiye dayandır; bilmediğin bir şeyi uydurmak yerine misafiri telefonla (+90 000 000 00 00) aramaya yönlendir.
- Belirli bir tarih/saat için müsaitlik sorulduğunda ASLA tahmin etme -- check_availability aracını çağır ve cevabını onun sonucuna dayandır.
- Misafir bir tarih, kişi sayısı ve (varsa) saat üzerinde anlaştığını belirtip rezervasyon yapmak istediğini söylediğinde prefill_reservation aracını çağır; sohbet üzerinden rezervasyonu sen tamamlamazsın, bu araç misafiri doldurulmuş bir formla rezervasyon bölümüne indirir.

${STATIC_FACTS}

${describeSettings(settings)}
`.trim();
}

module.exports = { buildSystemPrompt, fetchSettings, minutesToClock };
