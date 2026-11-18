# Mail otomasyonu — kurulum

Bu belge üç yeni otomasyonun elle yapılması gereken kurulum adımlarını
anlatır. Kodun kendisi için `api/_lib/mail.js`, `api/_lib/mail-templates.js`,
`api/_lib/inbox.js`, `api/_lib/digest.js`, `api/cron-reminders.js`,
`api/cron-digest.js` dosyalarına bakın; her dosyanın başında ne yaptığı ve
neden böyle tasarlandığı yazılı.

## Otomasyonlar

1. **Yeni rezervasyon bildirimi** — her gerçek rezervasyonda `MAIL_ALERT_TO`
   adresine mail gider (mevcut Telegram bildirimine ek).
2. **Müşteri hatırlatması** — `guest_email` dolu rezervasyonlar için
   rezervasyondan 2–4 saat önce, en fazla bir kez.
3. **Günlük gelen kutusu özeti** — her sabah 09:00 (Europe/Istanbul)
   gelen kutusu Claude ile özetlenip Telegram'a düşer.

## 1) Resend (mail gönderimi)

1. [resend.com](https://resend.com) üzerinde hesap açın.
2. **Domains** bölümünden kendi alan adınızı ekleyin.
3. Resend'in verdiği **SPF** ve **DKIM** TXT kayıtlarını alan adınızın
   DNS ayarlarına girin. Doğrulama birkaç dakika - birkaç saat sürebilir;
   panelde "Verified" göründüğünde tamamdır.
4. **API Keys** bölümünden bir anahtar üretin → `RESEND_API_KEY`.
5. `MAIL_FROM` değerini `"Sushier <rezervasyon@sushier.com>"` gibi,
   doğruladığınız alan adından bir adresle doldurun.
6. `MAIL_ALERT_TO` değerini yeni rezervasyon bildirimlerinin gideceği
   restoran adresiyle doldurun.

**Ücretsiz plan sınırları:** günde 100 mail (UTC gününe göre sıfırlanır,
yani Türkiye saatiyle 03:00'te), ayda 3.000 mail. Her rezervasyon ~1-2
mail (bildirim + varsa hatırlatma) tükettiğinden günde ~50 rezervasyonun
üzerine çıkarsanız ücretli plana geçmeniz gerekir.

## 2) Gmail (gelen kutusu özeti — IMAP + uygulama şifresi)

Gmail API yerine bilinçli olarak IMAP seçildi: `gmail.readonly` Google'ın
*kısıtlı kapsam* listesinde ve bir OAuth istemcisini "Testing" durumunda
bırakırsanız Google refresh token'ı **7 günde bir** geçersiz kılıyor —
cron sessizce ölür. Uygulama şifresiyle IMAP süresiz çalışır.

1. Gmail hesabında **2 Adımlı Doğrulama**'yı açın (uygulama şifresi
   bunsuz üretilemez): Google Hesabı → Güvenlik → 2 Adımlı Doğrulama.
2. Google Hesabı → Güvenlik → **Uygulama şifreleri** → yeni bir şifre
   üretin (isim olarak "Sushier" verebilirsiniz) → 16 haneli şifreyi
   kopyalayın → `IMAP_APP_PASSWORD`.
3. `IMAP_USER` = gelen kutusunun tam adresi (örn. `restoran@gmail.com`).
4. `IMAP_HOST=imap.gmail.com`, `IMAP_PORT=993` (`.env.example`'da hazır).
5. Gmail ayarlarında **Tüm POP/IMAP ayarları** sekmesinden IMAP'ın açık
   olduğunu doğrulayın (genelde varsayılan olarak açıktır).

Otomasyon gelen kutusuna **salt-okunur** bağlanır: hiçbir maili okundu
işaretlemez, taşımaz veya silmez; sadece gönderen/konu/tarih ve kısa bir
önizleme okur.

## 3) GitHub Actions (zamanlama)

Vercel'in Hobby planındaki cron günde yalnızca bir kez çalışabildiği için
saatlik hatırlatma tetikleyicisi GitHub Actions'ta
(`.github/workflows/cron-reminders.yml`, `cron-digest.yml`).

1. Repo → **Settings → Secrets and variables → Actions**.
2. **Secrets** sekmesinde `CRON_SECRET` ekleyin — Vercel'deki
   `CRON_SECRET` ile **aynı** rastgele değer olmalı (örn.
   `openssl rand -hex 32` ile üretin).
3. **Variables** sekmesinde `SITE_URL` ekleyin, örn.
   `https://sushier.vercel.app` (başında `https://`, sonunda `/` olmadan).

**Bilinmesi gerekenler:**

- GitHub, **public repo'larda 60 gün hiç commit/aktivite olmazsa**
  zamanlanmış workflow'ları otomatik devre dışı bırakır (sahibine mail
  atar); herhangi bir push yeniden etkinleştirir.
- Zamanlanmış çalıştırmalar yoğun saatlerde birkaç dakika gecikebilir —
  hatırlatmanın 2–4 saatlik penceresi bunu zaten tolere ediyor.
- İlk kurulumdan sonra her iki workflow'u **Actions** sekmesinden
  **Run workflow** ile elle bir kez tetikleyip yeşil döndüğünü görün.

## 4) Vercel ortam değişkenleri

Aşağıdaki değişkenlerin tümünü Vercel projesinin **Production** (ve
isterseniz **Preview**) ortamına ekleyin — tam liste ve açıklamaları
`.env.example` dosyasında:

`RESEND_API_KEY`, `MAIL_FROM`, `MAIL_ALERT_TO`, `CRON_SECRET`,
`IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_APP_PASSWORD`.

`ANTHROPIC_API_KEY` zaten sohbet asistanı için ayarlı olmalı — günlük
özet de aynı anahtarı kullanır.

## 5) Supabase migration

`supabase/migrations/0007_reservation_reminders.sql` dosyasını Supabase
projenize uygulayın (Supabase CLI ile `supabase db push`, ya da panelin
SQL Editor'ünden elle çalıştırarak).

## Doğrulama

**Yerel** (`npx vercel dev --listen 3000`, `.env.development.local`'e
yukarıdaki değişkenleri ekleyerek):

```bash
curl -X POST http://localhost:3000/api/cron-reminders \
  -H "Authorization: Bearer <CRON_SECRET>"

curl -X POST http://localhost:3000/api/cron-digest \
  -H "Authorization: Bearer <CRON_SECRET>"
```

Hatırlatmayı 3 saat beklemeden test etmek için: Supabase'de bir test
rezervasyonunun `service_date`/`slot_minute` değerlerini `starts_at`'i şu
andan ~3 saat sonraya düşürecek şekilde ayarlayın ve `reminder_sent_at`'i
`null` bırakın, sonra yukarıdaki `cron-reminders` komutunu çalıştırın.
Aynı komutu tekrar çalıştırdığınızda `claimed: 0` dönmesi, aynı misafire
iki kez gitmediğini doğrular.

**Üretimde:** deploy sonrası her iki workflow'u GitHub Actions
sekmesinden elle (`workflow_dispatch`) bir kez çalıştırın; ardından
Vercel'in runtime loglarında `[mail]`, `[inbox]`, `[digest]` etiketli
satırları kontrol edin.
