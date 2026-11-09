# AXON PMS · Production readiness raporu

- **Tarih:** 9 Kasım 2026
- **Commit:** `0dbc748` ve web sohbet sınırı düzeltmesi
- **Canlı adres:** https://axon-pms.vercel.app
- **Veritabanı:** Supabase `axon-pms` (eu-central-1), şema `20261108000700`

**Kural:** "Hazır" yalnızca otomatik testle **ve** mümkün olan yerde canlı ortamda doğrulanmış özellikler için yazıldı.

| İşaret | Anlamı |
|---|---|
| ✅ Hazır | Test edildi, pilotta kullanılabilir |
| 🟡 Koşullu | Kod ve testler hazır; gerçek kullanım için anahtar, sözleşme veya plan gerekiyor |
| ⛔ Hazır değil | Yapılmadı veya doğrulanamadı |

## 1. Sonuç

Sistem, **yalnızca kendi direkt rezervasyonlarını yöneten** bir butik otelde pilot için teknik olarak hazır. Pilot başlamadan önce üç koşul var:

1. **Supabase Pro'ya geçmek.** Bugün Free planda ve otomatik yedek yok; bkz. `BACKUP_RESTORE.md`.
2. **Supabase'de "Leaked password protection"ı açmak.**
3. **Kullanıcıların gerçek giriş akışını otelde bir kez uçtan uca denemek.** Elimde giriş bilgisi olmadığı için canlıda personel ekranlarını yalnızca yetkisiz erişim açısından test edebildim.

Booking.com ve Expedia **DEMO** durumda. Gerçek bağlantı için sertifikalı bir kanal yöneticisi ya da kanalların iş ortağı erişimi gerekiyor; bkz. bölüm 3.

## 2. Test kanıtları

| Alan | Test | Sonuç |
|---|---|---|
| Veritabanı kuralları (Aşama 1–5) | 39 + 61 + 5 eşzamanlılık + 57 + 41 + 62 | Hepsi geçti |
| Kanal yöneticisi ve denetim kaydı (Aşama 6) | `80_ota_audit.sql`: 81 kontrol | Hepsi geçti |
| Tüm şemanın güvenlik taraması | `85_security_scan.sql`: 21 kontrol | Hepsi geçti |
| Performans (60 oda, 26 bin rezervasyon) | `90_performance.sql`: 9 kontrol | Hepsi geçti |
| Uygulama birim testleri | Vitest: 129 test | 129 geçti, 6 atlandı |
| Build ve tip kontrolü | `next build`, `tsc` | Temiz |
| Responsive tasarım | Playwright: 375 / 768 / 1440 px, 11 ekran + 2 ekran sahte veriyle | Yatay taşma yok, konsol hatası yok |
| Yedek ve geri yükleme | Gerçek prova | Satır sayıları aynı, tarama geçti |
| Canlı güvenlik probları | Herkese açık anahtarla 32 tablo ve fonksiyonlar, uygulama uçları | Sızıntı yok |

Toplam: 376 veritabanı testi ve 129 uygulama testi.

**Neden 6 test atlandı:** Bunlar finans çapraz doğrulama testleri ve bir veri dosyası gerektiriyor. `npm run db:test` ile çalışıyorlar.

**Bir test bilinçli olarak değiştirildi:** "Kullanıcı sayısı 4" testi, kanal yöneticisi servis hesabı nedeniyle artık servis hesabını ayrıca kontrol ediyor. Gizlenen bir hata yok.

**Testlerin gerçekten hata yakaladığını da sınadım:** Güvenlik taramasını, bilinçli olarak üç açık eklenmiş bir kopyada çalıştırdım:

- herkese açılmış bir tablo
- RLS'si kapatılmış bir tablo
- korumasız bir fonksiyon

Tarama 7 kontrolde başarısız olarak üç açığın üçünü de yakaladı.

## 3. Özellikler

### Booking.com ve Expedia kanal yöneticisi

| Özellik | Durum | Kanıt |
|---|---|---|
| Adaptör mimarisi (Booking.com B.XML müsaitlik, Expedia EQC AvailRateUpdate) | 🟡 | Birim testleri: istek yapısı, XML kaçışı, sonuç sınıflandırması. **Gerçek uçlarla sertifikalı değil.** |
| Kimlik bilgisi yokken DEMO; DEMO kanaldan hiçbir şey dışarı gitmez | ✅ | Birim testi + canlıda `/api/ota/webhook/booking` 503 DEMO dönüyor |
| Müsaitlik ve fiyat senkronizasyonu (ARI) kuyruğu | ✅ veritabanında | Rezervasyon, iptal, oda arızası, fiyat değişikliği gönderilecek geceleri işaretliyor; değer gönderim anında veritabanından okunuyor. **Fiyatı olmayan gece kanala "kapalı" gönderiliyor, tahmini fiyat asla.** |
| Kanaldan gelen rezervasyon, değişiklik, iptal | ✅ veritabanında, 🟡 gerçek kanal | Normal rezervasyon kurallarından geçiyor (çakışma koruması, folyo, komisyon). Oda tipi değişikliği ve uzatma test edildi. |
| Aşırı rezervasyon (overbooking) koruması | ✅ | Kanal boşta olmayan odayı sattığında rezervasyon sıkıştırılmıyor; "Müdahale gerekli" alarmı açılıyor. Personel odayı boşaltıp tek tıkla yeniden deniyor. |
| Webhook idempotency | ✅ | Aynı mesaj kimliği bir kez işleniyor; aynı rezervasyon için ikinci "yeni" mesaj yok sayılıyor |
| Hata yönetimi ve retry | ✅ | Ayrıntılar aşağıda |
| `/channels` ekranı | ✅ yerelde | Bağlantılar, DEMO/LIVE, oda eşleştirme, kuyruk, mesajlar, simülatör. Sahte Supabase ile 3 boyutta ekran görüntüsü alındı; canlıda girişsiz erişim reddediliyor. |
| Otomatik senkronizasyon zamanlayıcısı | 🟡 | Ayrıntılar aşağıda |

Hata yönetimi ve retry'ın ayrıntıları:

- **Geçici hatalar** (ağ, 5xx, 429) 2, 4, 8 dakika… aralıklarla, en fazla 6 saat bekleyerek yeniden deneniyor.
  - Kanala gönderim 10 denemeden sonra durup "Gönderilemeyen" olarak işaretleniyor.
  - Kanaldan gelen mesaj 8 denemeden sonra "Denemeler bitti" oluyor.
- **4xx hatası veya iş kuralı hatası** yeniden denenmiyor; doğrudan personele düşüyor.
- **Webhook yanıtı:** mesaj kaydedildiyse 200, kaydedilemediyse 500 dönüyor; böylece gönderen tekrar yolluyor.
- **Değişiklik rezervasyondan önce gelirse** kaybolmuyor; rezervasyon gelince işleniyor.

Zamanlayıcının ayrıntıları:

- Vercel cron günde bir kez çalışıyor (03:17 UTC). Vercel Hobby planı sık cron'a izin vermiyor.
- Gerçek kanal için **5 dakikada bir** çalışması gerekir. Bunun için Vercel Pro ya da dış bir zamanlayıcı lazım.
- Bu arada müdür "Şimdi senkronize et" düğmesini kullanabilir.

### Güvenlik, yetkiler, izolasyon

| Özellik | Durum | Kanıt |
|---|---|---|
| Rol yetkileri (owner, manager, front desk, housekeeping, kat şefi) | ✅ | Her fazın testleri ve tarama. Front desk ve housekeeping yapılandırma, fiyat, oda ve üyelik tablolarında 0 satır değiştirebiliyor. Housekeeping misafir, mesaj, folyo ve denetim verisinden 0 satır okuyabiliyor. |
| Çok kiracılı (multi-tenant) izolasyon | ✅ | Başka bir otel grubunun sahibi 28 tablonun **hepsinde** 0 satır okuyor ve 0 satır değiştirebiliyor. Kontrolün boş geçmediği doğrulandı: kendi sahibi 28 tablonun 28'inde veri görüyor. |
| RLS her tabloda açık; anonim rolün tablo yetkisi yok | ✅ | Tarama + canlıda 32 tablo için 401 |
| Herkese açık fonksiyonlar tam liste olarak sabit | ✅ | Tarama, listede olmayan yeni bir fonksiyonu başarısız sayar. Canlıda aynı 15 fonksiyon var. |
| Her RPC çağıranı kontrol ediyor | ✅ | Yapısal tarama; istisnalar yalnızca `health_check` ve `inbox_public_property` |
| SQL injection yüzeyi | ✅ | Fonksiyonlarda dinamik SQL yok; tırnaklı ve SQL içeren girdiler veri olarak işleniyor |
| Her API rotası ya bilinen bir herkese açık giriş noktası ya da oturum ve aynı-kaynak (CSRF) korumalı | ✅ | Yapısal birim testi tüm rota dosyalarını tarıyor |
| Girdi doğrulama | ✅ | JSON 20 KB, webhook 256 KB üst sınırı; UUID, tarih, kod ve tutar biçim kontrolleri hem API'de hem veritabanında. Canlıda bozuk JSON, büyük gövde ve sahte token reddedildi. |
| Güvenlik başlıkları | ✅ | Canlıda doğrulandı: CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy |
| Web sohbet taşkın koruması | ✅ | Ayrıntılar aşağıda |
| Sırlar | ✅ | Webhook, kanal ve oturum anahtarları veritabanında yalnızca SHA-256 özeti olarak tutuluyor. Kanal yöneticisi servis hesabının şifresi yok ve girişi yasaklı. |

Web sohbet taşkın korumasının ayrıntıları:

- **Bulunan hata:** Uygulamadaki IP başına sınır her sunucu örneğinin kendi belleğinde tutuluyordu. Canlıda 45 hızlı isteğin hiçbiri sınırlanmadı.
- **Düzeltme:** Sınır veritabanına taşındı; bir otel için dakikada en fazla 30 yeni sohbet. Canlıda 31. istekten itibaren 429 dönüyor.

### Denetim kaydı (audit log)

| Özellik | Durum | Kanıt |
|---|---|---|
| Kapsam | ✅ | 16 tablodaki ekleme, değişiklik ve silme kaydediliyor: rezervasyon, misafir, oda, fiyat, üyelik, kanal ayarları, folyo durumu vb. Kimin yaptığı yazılıyor (kullanıcı, sistem ya da veritabanı). |
| Mevcut kayıtlarla birlikte bütünlük | ✅ | Oda durumu, housekeeping, folyo hareketleri ve KVKK erişim kayıtlarının kendi ayrıntılı kayıtları zaten vardı |
| Değiştirilemez | ✅ | Veritabanı sahibi dahil hiç kimse güncelleyemiyor, silemiyor ya da boşaltamıyor |
| Kişisel veri yok | ✅ | Ad, e-posta, telefon ve notlar maskeleniyor. Test, tüm test verisinde denetim kaydında e-posta veya telefon kalmadığını doğruluyor. |
| `/audit` ekranı | ✅ yerelde | Yalnızca owner ve manager görebiliyor |

### Hata izleme ve loglar

| Özellik | Durum | Kanıt |
|---|---|---|
| Yapılandırılmış JSON loglar | ✅ | Her olay tek satır: zaman, seviye, olay, commit. Ad, e-posta, telefon, token ve mesaj gövdesi maskeleniyor (birim testi). |
| Yakalanmamış sunucu hataları | ✅ | `instrumentation.ts` (onRequestError) her hatayı tek log satırına yazıyor |
| `/api/health` | ✅ | Canlıda: veritabanı yanıtı, şema sürümü ve commit. p50 0,31 sn, p95 0,39 sn (20 istek, veritabanı dahil). |
| Uyarı loglanan durumlar | ✅ | Müdahale gereken kanal mesajı, kanala gönderim sorunu, kaydedilemeyen webhook, kötü imza |
| Hata takip servisi (Sentry vb.) ve uyarı bildirimi (e-posta/SMS) | ⛔ | Yok. Loglar yalnızca Vercel çalışma loglarında. Bkz. kurulum listesi. |

### Performans

60 oda ve yaklaşık 26 bin rezervasyonla, yerel PostgreSQL 16'da ölçüldü:

| İşlem | Süre |
|---|---|
| Haftalık müsaitlik | 2 ms |
| 14 günlük doluluk tablosu (tape chart) | 0,4 ms |
| **1 yıllık finans raporu verisi** | **2,4 ms** (önce 690 ms) |
| Yeni rezervasyon (folyo, denetim ve kanal kuyruğu dahil) | 1,6 ms |
| 500 gecelik kanal gönderim hesabı | 104 ms |

**Bulunan sorun ve düzeltmesi:** Satır güvenliği (RLS) politikaları yetki fonksiyonunu her satır için ayrı çağırıyordu. Aynı kurallar artık her sorguda bir kez hesaplanıyor. Kuralların anlamı değişmedi; 376 testin hepsi yeni politikalarla geçti.

**Canlı ölçümler:** `/login` p50 0,15 sn. HTTP yük testi (eşzamanlı kullanıcı) yapılmadı; bkz. bölüm 5.

### Responsive tasarım

| Kapsam | Durum | Kanıt |
|---|---|---|
| Telefon 375, tablet 768, masaüstü 1440 px | ✅ Chromium | 11 ekran demo verisiyle; Kanallar ve Denetim sahte Supabase verisiyle. Yatay taşma yok, konsol hatası yok. |
| Safari / iOS gerçek cihaz | ⛔ | Test edilmedi |
| Küçük dokunma alanı | Küçük not | Housekeeping ekranında 20 px'lik bir onay kutusu var (Aşama 4'ten kalma). Tıklanabilir etiketin içindeyse sorun değil; cihazda kontrol edin. |

### Önceki fazlar (değişmedi, testleri yeniden geçti)

Oda durumu motoru, rezervasyon ve çakışma koruması, folyo ve KPI'lar, housekeeping, misafir CRM, KVKK ve AI inbox.

## 4. Eksik entegrasyonlar

| Entegrasyon | Durum | Gerçek moda geçmek için gereken |
|---|---|---|
| Booking.com | DEMO | Booking.com Connectivity Partner sertifikası ya da sertifikalı bir kanal yöneticisi (SiteMinder, Channex vb.). Ayrıntılar aşağıda. |
| Expedia | DEMO | Expedia EQC erişimi ya da kanal yöneticisi. Ortam değişkenleri `EXPEDIA_EQC_USERNAME` ve `EXPEDIA_EQC_PASSWORD`. |
| Rezervasyonları kanaldan çekmek (pull) | Yok | Booking.com ve Expedia rezervasyonları normalde çekme yöntemiyle verir; bu kısım yazılmadı. Şu an yalnızca imzalı webhook (push) ile normalize edilmiş JSON kabul ediliyor. Kanal yöneticisi bu biçime uyarlanmalı. |
| Fiyat planları ve kısıtlar | Yok | Kanal başına oda tipi başına tek fiyat planı var. Minimum konaklama, giriş/çıkış kısıtları ve kanala özel fiyat farkı yok. |
| WhatsApp ve Instagram | DEMO | Meta anahtarları (Aşama 5 raporu) |
| Dil modeli (LLM) | Yok | Anlama katmanı kural tabanlı; rakamlar her durumda veritabanından gelir |
| Hata takibi ve uyarı bildirimi | Yok | Sentry veya Vercel log drain; NEEDS_ATTENTION için e-posta/SMS |
| Ödeme ve POS, e-Fatura, kimlik bildirimi (KBS) | Yok | Kapsam dışı |

Booking.com için gerçek moda geçiş adımları:

1. Vercel'e `BOOKING_XML_USERNAME` ve `BOOKING_XML_PASSWORD` ekleyin.
2. Vercel'e `OTA_PROPERTY`, `OTA_SYNC_SECRET`, `OTA_WEBHOOK_SECRET` ve `CRON_SECRET` ekleyin.
3. Kanallar ekranında otel kimliğini girip "Gerçek moda al"a basın.

## 5. Bilinen hatalar ve sınırlamalar

| # | Konu | Etki | Durum / öneri |
|---|---|---|---|
| 1 | Supabase Free plan: otomatik yedek yok | Veri kaybı riski | **Pilot öncesi zorunlu:** Pro plan ve/veya `db-backup.sh` |
| 2 | Leaked password protection kapalı | Sızmış şifrelerle giriş mümkün | Supabase Auth ayarından açın |
| 3 | Uygulama içi IP hız sınırı sunucu örneği başına | Yalnızca web sohbet başlatma etkileniyordu | Veritabanı sınırıyla düzeltildi. Mesaj gönderme zaten sohbet başına dakikada 20 ile sınırlı. Ek olarak Vercel Firewall rate limit önerilir. |
| 4 | Kanal senkronizasyonu günde bir kez otomatik | Gerçek kanalda müsaitlik geç güncellenir, aşırı rezervasyon riski | Vercel Pro (5 dk cron) ya da dış zamanlayıcı. DEMO'da etkisi yok. |
| 5 | XML biçimleri sertifikasız | Gerçek kanal ilk denemede istekleri reddedebilir | Reddedilen gönderim "Gönderilemeyen" olur, sessizce kaybolmaz. Sertifikasyon gerekli. |
| 6 | CSP'de `script-src 'unsafe-inline'` | Next.js nonce'suz çalıştığı için gerekli | İleride nonce tabanlı CSP |
| 7 | Canlıda giriş yapılmış personel ekranları test edilmedi | Giriş bilgim yok | Kurulum listesindeki duman testi |
| 8 | Safari / iOS gerçek cihaz testi yok | Görsel farklar olabilir | Pilotta bir iPhone ile kontrol |
| 9 | HTTP yük testi yapılmadı | Eşzamanlı kullanım sınırı bilinmiyor | Butik otel ölçeğinde düşük risk; veritabanı ölçümleri iyi |
| 10 | Kanal simülatörü gerçek rezervasyon oluşturuyor | Raporlara girebilir | "DEMO kanal simülasyonu" notu taşıyor; denemeden sonra iptal edin |
| 11 | Yeni ekranlar (Kanallar, Denetim) yalnızca Türkçe | EN seçili olsa da metin Türkçe | Çeviri eklenecek |
| 12 | Denetim kaydı için saklama süresi tanımlı değil | Kayıtlar süresiz birikir (kişisel veri içermez) | Saklama süresini muhasebecinizle belirleyin |
| 13 | Supabase uyarıları: "SECURITY DEFINER fonksiyonu çalıştırılabilir" (73) ve "politikasız RLS tablosu" (1) | Bilinçli tasarım: tüm yazmalar kontrollü fonksiyonlardan geçiyor, `reservation_idempotency` tamamen kapalı | Değişiklik gerekmiyor |

## 6. Pilot otel kurulum kontrol listesi

### A. Hesaplar ve güvenlik (otel sahibi yapar)

- [ ] Supabase organizasyonunu **Pro**'ya yükseltin (günlük yedek). İsteğe bağlı PITR.
- [ ] Supabase → Authentication → "Leaked password protection"ı açın.
- [ ] Supabase → Authentication → yalnızca davetle kayıt; e-posta onayı açık olsun.
- [ ] Vercel'de yalnızca ihtiyacı olan kişiler ekip üyesi olsun. Supabase'de service_role anahtarını hiçbir yere koymayın.

### B. Otel verisi

- [ ] Otel sahibi `/onboarding` ile kendi otelini oluşturur. Demo otel (`axon-demo`) pilotta kullanılmaz.
- [ ] Oda tipleri ve odalar; gecelik fiyatlar (vergi hariç). KDV ve konaklama vergisi oranlarını muhasebeciyle doğrulayın.
- [ ] Kanal komisyon oranlarını sözleşmenize göre kontrol edin (varsayılan: Booking.com %18, Expedia %15; owner ve manager değiştirebilir).
- [ ] Personel hesapları ve rolleri: owner, manager, front_desk, housekeeping, hk_supervisor.
- [ ] Sıkça Sorulan Sorular cevapları (AI asistan yalnızca bunları söyler).
- [ ] KVKK aydınlatma metni ve saklama süresi (hukuk danışmanı).

### C. Kanallar

- [ ] Kanallar ekranında her oda tipini Booking.com ve Expedia oda koduyla eşleştirin.
- [ ] Kanal yöneticisi veya iş ortağı erişimi gelene kadar kanallar DEMO kalsın. **Bu dönemde OTA rezervasyonlarını elle girin.**
- [ ] Gerçek moda geçişte:
  1. Vercel'e `OTA_PROPERTY=<org-slug>/<KOD>` ekleyin.
  2. `OTA_SYNC_SECRET` ve `OTA_WEBHOOK_SECRET` ekleyin (en az 24 karakter, farklı değerler).
  3. `CRON_SECRET` ve kanal kimlik bilgilerini ekleyin.
  4. Yeniden yayın yapın.
  5. Kanallar ekranında "Gerçek moda al"a basın.
  6. Senkronizasyonu 5 dakikada bir çalıştıracak zamanlayıcıyı kurun.
- [ ] Gerçek moddaki ilk gün, kanaldaki müsaitliği ekranla elle karşılaştırın.
- [ ] Anahtarları sohbete veya koda yazmayın; yalnızca Vercel ortam değişkenlerine.

### D. Operasyon

- [ ] Uptime izleme: `https://<alan-adı>/api/health` için 5 dakikada bir kontrol (UptimeRobot vb.); 503'te uyarı.
- [ ] Vercel → Logs: `level":"error"` ve `ota_event_needs_attention` olaylarını günde bir kontrol edin, ya da log drain kurun.
- [ ] Gece denetimini (night audit) her gün çalıştırın.
- [ ] Kanallar ekranındaki "Müdahale gerekli" alarmlarını her vardiya başında kontrol edin.
- [ ] Ayda bir geri yükleme provası: `scripts/db-restore-check.sh` (bkz. `BACKUP_RESTORE.md`).

### E. Canlıya almadan önce duman testi (otelde, gerçek kullanıcılarla)

1. [ ] Her rol ile giriş; her rol yalnızca kendi menüsünü görmeli.
2. [ ] Rezervasyon oluşturun ve aynı odaya çakışan ikinci rezervasyonu deneyin; reddedilmeli.
3. [ ] Check-in, ardından check-out; oda kirli görünmeli ve housekeeping görevi açılmalı.
4. [ ] Housekeeping telefonundan görevi bitirin; kat şefi onaylasın.
5. [ ] Folyoya ekstra ve ödeme girin, gece denetimini çalıştırın, raporu kontrol edin.
6. [ ] Web sohbetten müsaitlik sorun; fiyat Raporlar ve fiyat ekranıyla aynı olmalı.
7. [ ] Kanal simülatörüyle yeni, değişiklik ve iptal mesajı gönderin; sonra simülasyon rezervasyonlarını iptal edin.
8. [ ] Denetim ekranında bu işlemlerin göründüğünü kontrol edin.
9. [ ] Telefon, tablet ve masaüstünde (Safari dahil) ana ekranlara bakın.

## 7. Bu fazda değişen dosyalar

| Alan | Dosyalar |
|---|---|
| Veritabanı | `supabase/migrations/20261108000700_ota_audit_ops.sql`, `20261108000800_webchat_rate_limit.sql` |
| Testler | `supabase/tests/80_ota_audit.sql`, `85_security_scan.sql`, `90_performance.sql`, `tests/ota.test.ts` |
| Uygulama | `src/lib/ota/*`, `src/lib/log.ts`, `src/lib/public-paths.ts`, `src/instrumentation.ts` |
| Rotalar | `src/app/api/ota/**`, `src/app/api/health` |
| Ekranlar | `src/app/channels`, `src/app/audit` |
| Ayarlar | `next.config.ts` (CSP vb.), `vercel.json` (cron) |
| Betikler ve belgeler | `scripts/db-backup.sh`, `scripts/db-restore-check.sh`, `docs/BACKUP_RESTORE.md` |
