// api/review.js - Doğrudan Tıklanabilir Kutucuklu (Button) Anket Paneli
export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eliza Hotel - Kutucuklu Anket Paneli</title>
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
    <h2>Eliza Hotel Kutucuklu Anket Paneli</h2>
    <p style="font-size: 13px; color: #666;">Misafire tıklanabilir kutucuklu anket gönderin:</p>
    
    <label>Misafirin Adı Soyadı:</label>
    <input type="text" id="guestName" value="Gülcan Hanım" />

    <label>Misafirin Telefon Numarası:</label>
    <input type="text" id="phoneNumber" value="905540248698" />

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
          resultDiv.innerHTML = '<strong>Anket Başarıyla Gönderildi!</strong><br/>WhatsApp uygulamanızı kontrol edin, tıklanabilir kutucuklar ekrana geldi.';
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

      // 20 karakter sınırına tam uyumlu butonlar
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
        ru: {
          body: `Уважаемый(ая) ${guestName || 'Гость'}, благодарим вас за пребывание в Eliza Hotel. Надеемся, поездка прошла отлично!\n\nКак вы оцениваете проживание?`,
          b1: '⭐⭐⭐⭐⭐ 5 - Отлично',
          b2: '⭐⭐⭐⭐ 4 - Хорошо',
          b3: '👎 1-3 Плохо'
        }
      };

      const set = buttonSets[language] || buttonSets['en'];

      // WhatsApp Resmi Tıklanabilir Kutucuk (Button) Formatı
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
            text: 'Lütfen aşağıdaki kutucuklardan birine dokunun:'
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'rate_5', title: set.b1 } },
              { type: 'reply', reply: { id: 'rate_4', title: set.b2 } },
              { type: 'reply', reply: { id: 'rate_low', title: set.b3 } }
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
