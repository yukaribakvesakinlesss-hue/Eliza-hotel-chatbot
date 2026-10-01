// api/review.js - 1'den 5'e Tam Anketli (Poll) Check-Out Paneli
export default async function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eliza Hotel - 1-5 Anketli Check-Out Paneli</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 30px; display: flex; justify-content: center; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); width: 100%; max-width: 500px; }
    h2 { margin-top: 0; color: #1a2a3a; border-bottom: 2px solid #c5a059; padding-bottom: 10px; }
    label { font-size: 13px; font-weight: 600; color: #444; display: block; margin-top: 15px; margin-bottom: 5px; }
    input, select { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
    button { margin-top: 25px; width: 100%; padding: 12px; background: #c5a059; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { background: #b08d4b; }
    #result { margin-top: 20px; padding: 15px; border-radius: 6px; display: none; font-size: 14px; line-height: 1.5; }
    .success { background: #e8f5e9; border: 1px solid #a5d6a7; color: #2e7d32; }
    .error { background: #ffebee; border: 1px solid #ffcdd2; color: #c62828; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Eliza Hotel 1-5 Anket Paneli</h2>
    <p style="font-size: 13px; color: #666;">Misafire 1'den 5'e kadar tıklanabilir anket (poll) gönderin:</p>
    
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

    <button onclick="sendReviewRequest()" id="btn">1-5 Anket Mesajını Gönder</button>

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
        btn.innerText = '1-5 Anket Mesajını Gönder';
        btn.disabled = false;
        resultDiv.style.display = 'block';

        if (data.success) {
          resultDiv.className = 'success';
          resultDiv.innerHTML = '<strong>Anket Başarıyla Gönderildi!</strong><br/>WhatsApp uygulamanızı kontrol edin, 1-5 anket menüsü ulaştı.';
        } else {
          resultDiv.className = 'error';
          resultDiv.innerText = 'Hata: ' + (data.error || 'Mesaj iletilemedi.');
        }
      } catch (err) {
        btn.innerText = '1-5 Anket Mesajını Gönder';
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

      // Çok Dilli 1'den 5'e Anket (List/Poll) Konfigürasyonları
      const surveyData = {
        tr: {
          body: `Sayın ${guestName || 'Misafirimiz'}, Eliza Hotel'de konakladığınız için teşekkür ederiz. Umarız İstanbul seyahatiniz harika geçmiştir!\n\nKonaklamanızı 1 ile 5 arasında nasıl değerlendirirsiniz?`,
          btn: 'Puanınızı Seçin ⭐',
          title: 'Puanlama (1 - 5)',
          r5: { t: '⭐⭐⭐⭐⭐ 5 Puan', d: 'Mükemmel - Harika bir deneyim' },
          r4: { t: '⭐⭐⭐⭐ 4 Puan', d: 'Çok İyi - Memnun kaldım' },
          r3: { t: '⭐⭐⭐ 3 Puan', d: 'Orta - Geliştirilebilir' },
          r2: { t: '⭐⭐ 2 Puan', d: 'Yetersiz - Beklenti altı' },
          r1: { t: '⭐ 1 Puan', d: 'Kötü - Memnun kalmadım' }
        },
        en: {
          body: `Dear ${guestName || 'Guest'}, thank you for staying with us at Eliza Hotel. We hope you had a wonderful time in Istanbul!\n\nHow would you rate your stay from 1 to 5?`,
          btn: 'Rate Your Stay ⭐',
          title: 'Rating (1 - 5)',
          r5: { t: '⭐⭐⭐⭐⭐ 5 Stars', d: 'Excellent - Loved it' },
          r4: { t: '⭐⭐⭐⭐ 4 Stars', d: 'Very Good - Satisfied' },
          r3: { t: '⭐⭐⭐ 3 Stars', d: 'Average - Needs work' },
          r2: { t: '⭐⭐ 2 Stars', d: 'Poor - Below expectations' },
          r1: { t: '⭐ 1 Star', d: 'Terrible - Not satisfied' }
        },
        ar: {
          body: `عزيزي ${guestName || 'النزيل'}، شكراً لإقامتك في فندق إليزا. نأمل أن تكون رحلتك إلى إسطنبول رائعة!\n\nكيف تقيم إقامتك معنا من 1 إلى 5؟`,
          btn: 'اختر التقييم ⭐',
          title: 'التقييم (1 - 5)',
          r5: { t: '⭐⭐⭐⭐⭐ 5 نجوم', d: 'ممتاز - تجربة رائعة' },
          r4: { t: '⭐⭐⭐⭐ 4 نجوم', d: 'جيد جداً - راضٍ تماماً' },
          r3: { t: '⭐⭐⭐ 3 نجوم', d: 'متوسط - يحتاج تحسين' },
          r2: { t: '⭐⭐ نجمتان', d: 'ضعيف - دون التوقعات' },
          r1: { t: '⭐ نجمة واحدة', d: 'سيء - غير راضٍ' }
        },
        ru: {
          body: `Уважаемый(ая) ${guestName || 'Гость'}, благодарим вас за пребывание в Eliza Hotel. Надеемся, поездка прошла отлично!\n\nКак вы оцениваете проживание от 1 до 5?`,
          btn: 'Оценить проживание ⭐',
          title: 'Оценка (1 - 5)',
          r5: { t: '⭐⭐⭐⭐⭐ 5 баллов', d: 'Отлично - Всё супер' },
          r4: { t: '⭐⭐⭐⭐ 4 балла', d: 'Хорошо - Доволен' },
          r3: { t: '⭐⭐⭐ 3 балла', d: 'Средне - Есть минусы' },
          r2: { t: '⭐⭐ 2 балла', d: 'Плохо - Ниже ожиданий' },
          r1: { t: '⭐ 1 балл', d: 'Ужасно - Не понравилось' }
        }
      };

      const s = surveyData[language] || surveyData['en'];

      // WhatsApp Resmi 1'den 5'e Seçim Menüsü (List / Poll)
      const listPayload = {
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: {
            type: 'text',
            text: 'Eliza Hotel Istanbul'
          },
          body: {
            text: s.body
          },
          footer: {
            text: 'Lütfen bir puan seçin'
          },
          action: {
            button: s.btn,
            sections: [
              {
                title: s.title,
                rows: [
                  { id: 'rate_5', title: s.r5.t, description: s.r5.d },
                  { id: 'rate_4', title: s.r4.t, description: s.r4.d },
                  { id: 'rate_3', title: s.r3.t, description: s.r3.d },
                  { id: 'rate_2', title: s.r2.t, description: s.r2.d },
                  { id: 'rate_1', title: s.r1.t, description: s.r1.d }
                ]
              }
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
        body: JSON.stringify(listPayload)
      });

      const metaData = await metaRes.json();
