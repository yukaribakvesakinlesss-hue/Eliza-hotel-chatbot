// api/review.js - Eliza Hotel Check-Out & Review Booster Paneli
export default async function handler(req, res) {
  // 1. Tarayıcıdan Açıldığında Resepsiyon Paneli (GET)
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eliza Hotel - Check-Out Yorum Paneli</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 30px; display: flex; justify-content: center; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); width: 100%; max-width: 500px; }
    h2 { margin-top: 0; color: #1a2a3a; border-bottom: 2px solid #c5a059; padding-bottom: 10px; }
    label { font-size: 13px; font-weight: 600; color: #444; display: block; margin-top: 15px; margin-bottom: 5px; }
    input, select { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
    button { margin-top: 25px; width: 100%; padding: 12px; background: #c5a059; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #b08d4b; }
    #result { margin-top: 20px; padding: 15px; border-radius: 6px; display: none; font-size: 14px; line-height: 1.5; }
    .success { background: #e8f5e9; border: 1px solid #a5d6a7; color: #2e7d32; }
    .error { background: #ffebee; border: 1px solid #ffcdd2; color: #c62828; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Eliza Hotel Check-Out Paneli</h2>
    <p style="font-size: 13px; color: #666;">Çıkış yapan misafire WhatsApp memnuniyet anketi gönderin:</p>
    
    <label>Misafirin Adı Soyadı:</label>
    <input type="text" id="guestName" placeholder="Örn: John Smith veya Gülcan Hanım" value="Gülcan Hanım" />

    <label>Misafirin Telefon Numarası (Nasıl yazarsanız yazın sistem düzeltir):</label>
    <input type="text" id="phoneNumber" placeholder="Örn: +90 554 024 86 98 veya 0554..." value="905540248698" />

    <label>Mesajın Dili:</label>
    <select id="language">
      <option value="tr">Türkçe (TR)</option>
      <option value="en">İngilizce (EN)</option>
      <option value="ar">Arapça (AR)</option>
      <option value="ru">Rusça (RU)</option>
      <option value="fr">Fransızca (FR)</option>
      <option value="es">İspanyolca (ES)</option>
      <option value="de">Almanca (DE)</option>
    </select>

    <button onclick="sendReviewRequest()" id="btn">Check-Out Memnuniyet Mesajı Gönder</button>

    <div id="result"></div>
  </div>

  <script>
    async function sendReviewRequest() {
      const btn = document.getElementById('btn');
      const resultDiv = document.getElementById('result');
      btn.innerText = 'WhatsApp Mesajı Gönderiliyor...';
      btn.disabled = true;
      resultDiv.style.display = 'none';

      try {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            guestName: document.getElementById('guestName').value,
            phoneNumber: document.getElementById('phoneNumber').value,
            language: document.getElementById('language').value
          })
        });

        const data = await res.json();
        btn.innerText = 'Check-Out Memnuniyet Mesajı Gönder';
        btn.disabled = false;
        resultDiv.style.display = 'block';

        if (data.success) {
          resultDiv.className = 'success';
          resultDiv.innerHTML = '<strong>Mesaj Başarıyla Gönderildi!</strong><br/>WhatsApp uygulamanızı kontrol edin, anket ulaştı.';
        } else {
          resultDiv.className = 'error';
          resultDiv.innerText = 'Hata: ' + (data.error || 'Mesaj gönderilemedi.');
        }
      } catch (err) {
        btn.innerText = 'Check-Out Memnuniyet Mesajı Gönder';
        btn.disabled = false;
        resultDiv.style.display = 'block';
        resultDiv.className = 'error';
        resultDiv.innerText = 'Bağlantı hatası oluştu.';
      }
    }
  </script>
</body>
</html>
    `);
  }

  // 2. Butona Basıldığında Güvenli Mesaj Gönderimi (POST)
  if (req.method === 'POST') {
    try {
      const { guestName, phoneNumber, language } = req.body;

      // Hata Kalkanı 1: Telefon Numarası Temizleme ve Formatlama
      let cleanPhone = String(phoneNumber || '').replace(/\D/g, '');
      if (cleanPhone.startsWith('00')) cleanPhone = cleanPhone.substring(2);
      else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) cleanPhone = '9' + cleanPhone;
      else if (cleanPhone.length === 10 && cleanPhone.startsWith('5')) cleanPhone = '90' + cleanPhone;

      if (!cleanPhone || cleanPhone.length < 8) {
        return res.status(400).json({ error: 'Geçersiz telefon numarası girdiniz. Lütfen numarayı kontrol edin.' });
      }

      // Hata Kalkanı 2: Ortam Değişkeni Kontrolleri
      const phoneNumberId = process.env.WHATSAPP_PHONE_ID;
      const whatsappToken = process.env.WHATSAPP_TOKEN;

      if (!phoneNumberId || !whatsappToken) {
        return res.status(500).json({ error: 'Vercel üzerinde WHATSAPP_PHONE_ID veya WHATSAPP_TOKEN tanımlı değil.' });
      }

      // Çok Dilli Mesaj Şablonları
      const messages = {
        tr: `Sayın ${guestName || 'Misafirimiz'}, Eliza Hotel'de konakladığınız için teşekkür ederiz. Umarız İstanbul seyahatiniz harika geçmiştir!\n\nHizmetimizi 1 ile 5 arasında nasıl değerlendirirsiniz? (Örn: 5 yazarak cevaplayabilirsiniz)`,
        en: `Dear ${guestName || 'Guest'}, thank you for staying with us at Eliza Hotel. We hope you had a wonderful time in Istanbul!\n\nHow would you rate your stay with us from 1 to 5? (e.g. Reply with 5)`,
        ar: `عزيزي ${guestName || 'النزيل'}، شكراً لإقامتك في فندق إليزا. نأمل أن تكون رحلتك إلى إسطنبول رائعة!\n\nكيف تقيم إقامتك معنا من 1 إلى 5؟ (مثال: أرسل الرقم 5)`,
        ru: `Уважаемый(ая) ${guestName || 'Гость'}, благодаrim вас за пребывание в Eliza Hotel. Надеемся, ваша поездка в Стамбул прошла замечательно!\n\nКак бы вы оценили проживание от 1 до 5? (например, ответьте 5)`,
        fr: `Cher(e) ${guestName || 'Client(e)'}, merci d'avoir séjourné à Eliza Hotel. Nous espérons que votre séjour à Istanbul a été agréable !\n\nComment évalueriez-vous votre séjour de 1 à 5 ? (ex. Répondez avec 5)`,
        es: `Estimado/a ${guestName || 'Huésped'}, gracias por alojarse en Eliza Hotel. ¡Esperamos que haya disfrutado de su viaje a Estambul!\n\n¿Cómo calificaría su estancia del 1 al 5? (ej. Responda con 5)`,
        de: `Sehr geehrte(r) ${guestName || 'Gast'}, vielen Dank für Ihren Aufenthalt im Eliza Hotel. Wir hoffen, Sie hatten eine wunderbare Zeit in Istanbul!\n\nWie würden Sie Ihren Aufenthalt von 1 bis 5 bewerten? (z.B. Antworten Sie mit 5)`
      };

      const surveyText = messages[language] || messages['en'];

      console.log(` Check-Out Anketi Gönderiliyor -> Numara: ${cleanPhone}, Dil: ${language}`);

      const metaRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${whatsappToken}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: cleanPhone,
          text: { body: surveyText }
        })
      });

      const metaData = await metaRes.json();

      if (!metaRes.ok) {
        console.error('Meta API Hatası:', metaData);
        const errMsg = metaData.error ? metaData.error.message : 'Meta mesajı kabul etmedi.';
        return res.status(metaRes.status).json({ error: `WhatsApp Hatası: ${errMsg}` });
      }

      return res.status(200).json({ success: true, messageId: metaData.messages ? metaData.messages[0].id : null });
    } catch (error) {
      console.error('Review API Sunucu Hatası:', error);
      return res.status(500).json({ error: 'Sunucu tarafında beklenmedik bir hata oluştu.' });
    }
  }

  return res.status(405).json({ error: 'Yalnızca GET ve POST istekleri kabul edilir.' });
}
