# Veritabanı yedekleme ve geri yükleme

## Mevcut durum (9 Kasım 2026'da kontrol edildi)

Supabase organizasyonu "HOTEL AI ASSISTANT" **Free** planda. Supabase Free planda otomatik yedek almaz.
Kaynak: https://supabase.com/docs/guides/platform/backups. Bugün canlı veritabanında **hiçbir yedek yok**.

Pilot öncesi iki yoldan biri zorunlu:

| Yol | Ne sağlar | Maliyet |
|---|---|---|
| **A. Supabase Pro (önerilen)** | Günlük otomatik yedek, 7 gün saklama, panelden tek tıkla geri yükleme | Pro plan ücreti |
| A+. Pro + PITR eklentisi | Saniye hassasiyetinde geri dönüş (en kötü durumda yaklaşık 2 dakika veri kaybı) | Ek ücret; Small compute gerekli |
| **B. Kendi yedeğimiz** | `scripts/db-backup.sh` ile her gece mantıksal yedek | Ücretsiz; yedeklerin şifreli ve otel dışında saklanması sizin sorumluluğunuzda |

Önerimiz: Pro'ya geçin ve haftada bir B yoluyla ayrıca yedek alın. Böylece Supabase dışında da bir kopya olur.

## Yedek alma (B yolu)

```bash
# DATABASE_URL: Supabase → Project Settings → Database → Connection string (Session pooler)
# Değeri sohbete, koda veya repoya yazmayın; terminalde ortam değişkeni olarak verin.
DATABASE_URL='postgresql://…' bash scripts/db-backup.sh ./backups
```

Çıktı üç dosyadır: `axon-<zaman>.dump`, `axon-<zaman>.auth-users.dump` ve `axon-<zaman>.sha256`.

- Yedek misafir kişisel verisi içerir (KVKK). Şifreli bir konumda saklayın, örneğin şifreli disk veya erişimi kısıtlı bir depolama.
- Saklama süresini KVKK saklama politikanızla uyumlu tutun.
- **Yetkiler bilinçli olarak yedeğe dahil.** Hangi rolün neye erişebileceği güvenlik modelinin parçası.

## Geri yükleme provası (ayda bir yapın)

Provayı her zaman **boş, geçici** bir veritabanında yapın; canlıya asla.

```bash
SOURCE_URL='<yedeğin alındığı veritabanı>' TARGET_URL='<boş geçici veritabanı>' \
  bash scripts/db-restore-check.sh ./backups/axon-<zaman>.dump
```

Betik sırasıyla şunları yapar ve bir adım başarısız olursa durur:

1. Yedeğin sağlama toplamını (SHA-256) doğrular.
2. `pgcrypto` ve `btree_gist` eklentilerini hazırlar. Bunlar yedeğin içinde yoktur.
3. Hedefteki varsayılan geniş yetkileri kapatır. Supabase yeni tablolara anon ve authenticated için geniş varsayılan yetki verir; bu adım olmadan geri yüklenen tablolar açık kalır.
4. Yedeği geri yükler.
5. Her tablonun satır sayısını kaynakla karşılaştırır.
6. Güvenlik önlemlerinin yerinde olduğunu kontrol eder:
   - Denetim kaydı ve folyo defteri değiştirilemiyor olmalı.
   - Çakışan rezervasyonu engelleyen kısıt bulunmalı.
   - Her tabloda RLS açık olmalı.
   - Anonim rolün hiçbir tablo yetkisi olmamalı.

## Bu betiklerle yapılan prova (yerel PostgreSQL 16, 9 Kasım 2026)

Prova, 376 testin doldurduğu test veritabanıyla yapıldı.

- **32 tablonun hepsinde satır sayıları kaynakla aynı çıktı.** Prova yaklaşık 1,5 saniye sürdü; yedek dosyası 5,6 MB.
- **Geri yüklenen kopyada tam güvenlik taraması** (`tests/85_security_scan.sql`) çalıştırıldı; 20 kontrolün hepsi geçti.
- **Migration'ların tamamı kopyanın üzerinde yeniden çalıştırıldı;** tarama yine geçti.

Provada bulunan ve düzeltilen hatalar:

| Bulgu | Etkisi | Düzeltme |
|---|---|---|
| Yetkisiz alınan yedek (`--no-privileges`) | Geri yüklenen tablolar herkese açık kalıyordu | Yetkiler artık yedeğe dahil |
| Eklentiler yedekte yok | Geri yükleme yarıda kalıyordu | Betik eklentileri önceden kuruyor |
| Hedefteki varsayılan yetkiler | Tablolar fazla yetkiyle oluşuyordu | Betik varsayılanları önce kapatıyor |
| Migration'ları baştan tekrar çalıştırmak bir iç fonksiyonu yeniden açıyordu | İç fonksiyon dışarıya açılıyordu | Migration 0007 iç fonksiyon yetkilerini kesin olarak sıfırlıyor |

## Felaket senaryoları

| Durum | Ne yapılır |
|---|---|
| Yanlış toplu silme veya değişiklik | Pro: panelden önceki günün yedeğine dönün (proje bu sırada erişilemez). B: geçici bir projeye geri yükleyip gereken satırları taşıyın. Kimin neyi değiştirdiğini Denetim kaydı ekranında görün. |
| Supabase projesi silinirse | Supabase'in yedekleri de silinir. Yalnızca B yoluyla otel dışında tuttuğunuz yedek kurtarır. |
| Vercel çökerse | Veri Supabase'de kalır. Aynı commit'ten yeniden yayın yapılır (`/api/health` ile doğrulayın). |
