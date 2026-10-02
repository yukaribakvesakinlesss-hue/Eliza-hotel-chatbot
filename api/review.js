// api/review.js - 8 Dilde Tıklanabilir Kutucuklu Anket Paneli
export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eliza Hotel - Çok Dilli Anket Paneli</title>
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
    <h2>Eliza Hotel Çok Dilli Anket Paneli</h2>
    <p style="font-size: 13px; color: #666;">Misafire kendi dilinde butonlu WhatsApp anketi gönderin:</p>
    
    <label>Misafirin Adı Soyadı:</label>
    <input type="text" id="guestName" value="Gülcan Hanım" />

    <label>Misafirin Telefon Numarası:</label>
    <input type="text" id="phoneNumber" value="905540248698" />

    <label>Mesajın Dili:</label>
    <select id="language">
      <option value="tr">Türkçe (TR)</option>
      <option value="en">İngilizce (EN)</option>
      <option value="ar">Arapça (AR)</option>
      <option value="zh">Çince (ZH)</option>
      <option value="ru">Rusça (RU)</option>
      <option value="fr">Fransızca (FR)</option>
      <option value="es">İspanyolca (ES)</option>
      <option value="de">Almanca (DE)</option>
    </select>

    <button onclick="sendReviewRequest()" id="btn">Kutucuklu Anketi Gönder</button>

    <div id="result"></div>
  </div>

  <script>
    async function sendReviewRequest() {
      const btn = document.getElementById('btn');
      const resultDiv = document.getElementById('result');
      btn.innerText = 'Gönderiliyor...';
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
        btn.innerText = 'Kutucuklu Anketi Gönder';
        btn.disabled = false;
        resultDiv.style.display = 'block';

        if (data.success) {
          resultDiv.className = 'success';
          resultDiv.innerHTML = '<strong>Anket Başarıyla Gönderildi!</strong><br/>WhatsApp uygulamanızı kontrol edin, butonlar ekranda belirdi.';
        } else {
          resultDiv.className = 'error';
          resultDiv.innerText = 'Hata: ' + (data.error || 'Mesaj iletilemedi.');
        }
      } catch (err) {
        btn.innerText = 'Kutucuklu Anketi Gönder';
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

  if (req.method === 'POST') {
    try {
      const { guestName, phoneNumber, language } = req.body;

      let cleanPhone = String(phoneNumber || '').replace(/\D/g, '');
      if (cleanPhone.startsWith('00')) cleanPhone = cleanPhone.substring(2);
      else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) cleanPhone = '9' + cleanPhone;
      else if (cleanPhone.length === 10 && cleanPhone.startsWith('5')) cleanPhone = '90' + cleanPhone;

      const phoneNumberId = process.env.WHATSAPP_PHONE_ID;
      const whatsappToken = process.env.WHATSAPP_TOKEN;

      // 8 Dilde Kusursuz Gövde Metinleri ve Butonlar (20 Karakter Sınırına Tam Uyumlu)
      const buttonSets = {
        tr: {
          body: `Sayın ${guestName || 'Misafirimiz'}, Eliza Hotel'de konakladığınız için teşekkür ederiz. Umarız İstanbul seyahatiniz harika geçmiştir!\n\nKonaklamanızı nasıl değerlendirirsiniz?`,
          b1: '⭐⭐⭐⭐⭐ 5 - Mükemmel',
          b2: '⭐⭐⭐⭐ 4 - Çok İyi',
          b3: '👎 1-3 Düşük Puan'
        },
        en: {
          body: `Dear ${guestName || 'Guest'}, thank you for staying with us at Eliza Hotel. We hope you had a wonderful time in Istanbul!\n\nHow would you rate your stay?`,
          b1: '⭐⭐⭐⭐⭐ 5 - Excellent',
          b2: '⭐⭐⭐⭐ 4 - Very Good',
          b3: '👎 1-3 Low Rating'
        },
        ar: {
          body: `عزيزي ${guestName || 'النزيل'}، شكراً لإقامتك في فندق إليزا. نأمل أن تكون رحلتك إلى إسطنبول رائعة!\n\nكيف تقيم إقامتك معنا؟`,
          b1: '⭐⭐⭐⭐⭐ 5 ممتاز',
          b2: '⭐⭐⭐⭐ 4 جيد جداً',
          b3: '👎 1-3 تقييم منخفض'
        },
        zh: {
          body: `尊敬的 ${guestName || '贵宾'}，感谢您入住伊丽莎酒店（Eliza Hotel）。希望您的伊斯坦布尔之行愉快！\n\n您如何评价本次入住体验？`,
          b1: '⭐⭐⭐⭐⭐ 5分 极好',
          b2: '⭐⭐⭐⭐ 4分 很好',
          b3: '👎 1-3分 不满意'
        },
        ru: {
          body: `Уважаемый(ая) ${guestName || 'Гость'}, благодарим вас за пребывание в Eliza Hotel. Надеемся, поездка прошла отлично!\n\nКак вы оцениваете проживание?`,
          b1: '⭐⭐⭐⭐⭐ 5 - Отлично',
          b2: '⭐⭐⭐⭐ 4 - Хорошо',
          b3: '👎 1-3 Плохо'
        },
        fr: {
          body: `Cher(e) ${guestName || 'Client(e)'}, merci d'avoir séjourné à Eliza Hotel. Nous espérons que votre séjour a été agréable !\n\nComment évaluez-vous votre séjour ?`,
          b1: '⭐⭐⭐⭐⭐ 5 - Excellent',
          b2: '⭐⭐⭐⭐ 4 - Très bien',
          b3: '👎 1-3 Insatisfait'
        },
        es: {
          body: `Estimado/a ${guestName || 'Huésped'}, gracias por alojarse en Eliza Hotel. ¡Esperamos que haya disfrutado de su viaje!\n\n¿Cómo calificaría su estancia?`,
          b1: '⭐⭐⭐⭐⭐ 5 - Excelente',
          b2: '⭐⭐⭐⭐ 4 - Muy bueno',
          b3: '👎 1-3 Insatisfecho'
        },
        de: {
          body: `Sehr geehrte(r) ${guestName || 'Gast'}, vielen Dank für Ihren Aufenthalt im Eliza Hotel. Wir hoffen, Sie hatten eine gute Zeit!\n\nWie bewerten Sie Ihren Aufenthalt?`,
          b1: '⭐⭐⭐⭐⭐ 5 - Sehr gut',
          b2: '⭐⭐⭐⭐ 4 - Gut',
          b3: '👎 1-3 Nicht gut'
        }
      };

      const selectedLang = buttonSets[language] ? language : 'en';
      const set = buttonSets[selectedLang];

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: {
            type: 'text',
            text: 'Eliza Hotel Istanbul'
          },
          body: {
            text: set.body
          },
          footer: {
            text: 'Lütfen bir seçeneğe dokunun'
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: `rate_5_${selectedLang}`, title: set.b1 } },
              { type: 'reply', reply: { id: `rate_4_${selectedLang}`, title: set.b2 } },
              { type: 'reply', reply: { id: `rate_low_${selectedLang}`, title: set.b3 } }
            ]
          }
        }
      };

      const metaRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${whatsappToken}`
        },
        body: JSON.stringify(payload)
      });

      const metaData = await metaRes.json();

      if (!metaRes.ok) {
        console.error('Meta API Hatası:', metaData);
        return res.status(metaRes.status).json({ error: metaData.error ? metaData.error.message : 'Meta mesajı kabul etmedi.' });
      }

      return res.status(200).json({ success: true, messageId: metaData.messages ? metaData.messages[0].id : null });
    } catch (error) {
      console.error('Review API Hatası:', error);
      return res.status(500).json({ error: 'Sunucu hatası oluştu.' });
    }
  }

  return res.status(405).json({ error: 'Geçersiz istek türü.' });
}
