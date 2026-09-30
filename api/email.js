// api/email.js
export default async function handler(req, res) {
  // 1. Tarayıcıdan açıldığında doğrudan Test Sayfasını göster
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eliza Hotel E-Posta Test Paneli</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 30px; display: flex; justify-content: center; }
    .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); width: 100%; max-width: 520px; }
    h2 { margin-top: 0; color: #1a2a3a; border-bottom: 2px solid #c5a059; padding-bottom: 10px; }
    label { font-size: 13px; font-weight: 600; color: #444; display: block; margin-top: 15px; margin-bottom: 5px; }
    input, textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; font-family: inherit; }
    button { margin-top: 20px; width: 100%; padding: 12px; background: #c5a059; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #b08d4b; }
    #result { margin-top: 20px; padding: 15px; border-radius: 6px; display: none; font-size: 14px; line-height: 1.5; }
    .success { background: #e8f5e9; border: 1px solid #a5d6a7; color: #2e7d32; }
    .error { background: #ffebee; border: 1px solid #ffcdd2; color: #c62828; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Eliza Hotel E-Posta Asistanı Testi</h2>
    <p style="font-size: 13px; color: #666;">Yapay zekânın e-postayı okuyup yanıtlamasını test edin:</p>
    
    <label>Alıcı E-Postanız (Cevap bu maile gelecek):</label>
    <input type="email" id="fromEmail" value="yukaribakvesakinlesss@gmail.com" />

    <label>Gelen E-Posta Konusu:</label>
    <input type="text" id="subject" value="Room reservation and breakfast inquiry" />

    <label>Misafirin Gönderdiği Mesaj:</label>
    <textarea id="emailBody" rows="4">Hello, I am planning to visit Istanbul next month with my family. Is breakfast included in the room price, and how far is the hotel from the tram station? Best regards, Sarah</textarea>

    <button onclick="sendTestEmail()" id="btn">Test E-Postasını Gönder</button>

    <div id="result"></div>
  </div>

  <script>
    async function sendTestEmail() {
      const btn = document.getElementById('btn');
      const resultDiv = document.getElementById('result');
      btn.innerText = 'Yapay zekâ yanıtlıyor...';
      btn.disabled = true;
      resultDiv.style.display = 'none';

      try {
        const res = await fetch('/api/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromEmail: document.getElementById('fromEmail').value,
            subject: document.getElementById('subject').value,
            emailBody: document.getElementById('emailBody').value
          })
        });

        const data = await res.json();
        btn.innerText = 'Test E-Postasını Gönder';
        btn.disabled = false;
        resultDiv.style.display = 'block';

        if (data.success) {
          resultDiv.className = 'success';
          resultDiv.innerHTML = '<strong>Başarılı!</strong><br/>Karar: ' + data.decision + '<br/>Konu: ' + data.subject + '<br/><br/><em>E-posta kutunuzu (Spam dahil) kontrol edin, cevap ulaştı!</em>';
        } else {
          resultDiv.className = 'error';
          resultDiv.innerText = 'Hata: ' + JSON.stringify(data);
        }
      } catch (err) {
        btn.innerText = 'Test E-Postasını Gönder';
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

  // 2. Butona basıldığında Yapay Zekâ ve Resend çalışır
  if (req.method === 'POST') {
    try {
      const { fromEmail, subject, emailBody } = req.body;

      if (!emailBody || !fromEmail) {
        return res.status(400).json({ error: 'E-posta içeriği veya gönderen adresi eksik.' });
      }

      console.log(` Yeni E-Posta Geldi -> Gönderen: ${fromEmail}, Konu: ${subject}`);

      const systemPrompt = `
Sen, İstanbul Tarihi Yarımada'da yer alan butik "Eliza Hotel"in resmi kurumsal e-posta asistanısın.
Görevin; misafirlerden gelen e-postaları analiz etmek ve kurumsal bir dille yanıtlamaktır.

DESTEKLENEN DİLLER:
- Türkçe, İngilizce, Arapça, Rusça, Fransızca, İspanyolca, Çince, Almanca.
- Gelen e-posta hangi dilde yazılmışsa KESİNLİKLE o dilde kurumsal, nazik ve profesyonel bir yanıt oluştur.

AKILLI AYRIM KURALI:
1. STANDART SORULAR:
   - Kahvaltı dahil mi, check-in (14:00) / check-out (12:00) saatleri, Wi-Fi, havalimanı transferi, konum, oda olanakları, rezervasyon linki.
   - Aksiyon: "status": "AUTO_REPLY" yap ve misafire doğrudan gönderilecek eksiksiz, nazik bir kurumsal yanıt yaz.
2. ÖZEL TALEPLER (İNSAN ONAYI GEREKENLER):
   - Grup rezervasyonu, acente anlaşması, özel fiyat pazarlığı, şirket faturası, şikayet.
   - Aksiyon: "status": "NEEDS_REVIEW" yap ve personelin incelemesi için özel bir taslak hazırla.

OTEL BİLGİLERİ:
- Tesis: Eliza Hotel (27 Odalı Butik Otel).
- Konum: Fatih / İstanbul (Beyazıt Tramvayı 250 m, Çemberlitaş Tramvayı 300 m).
- Konsept: "Oda Kahvaltı" (Bed & Breakfast) - Kahvaltı fiyata dahildir.
- Odalar: Double, Twin, Quadruple, Family Room (Klima, TV, Wi-Fi, Minibar, Kettle, Banyo, Saç Kurutma, Balkon, Çalışma Masası, Ütü).
- Rezervasyon Linki: https://www.elizahotelistanbul.com
- İletişim: +90 212 520 81 00 | info@elizahotelistanbul.com

ÇIKTI FORMATI (JSON):
Yanıtını MUTLAKA şu formatta ver:
{
  "status": "AUTO_REPLY veya NEEDS_REVIEW",
  "subject": "Re: [Gelen Konu]",
  "replyText": "[Hazırladığın resmi yanıt metni]"
}
`;

      const openAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Gönderen: ${fromEmail}\nKonu: ${subject}\n\nİçerik:\n${emailBody}` }
          ],
          temperature: 0.3,
          response_format: { type: "json_object" }
        })
      });

      const openAiData = await openAiRes.json();
      const result = JSON.parse(openAiData.choices[0].message.content);

      console.log(' E-Posta Yanıtı Hazırlandı:', result);

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
          <h3 style="color: #1a2a3a; border-bottom: 2px solid #c5a059; padding-bottom: 8px; margin-top: 0;">Eliza Hotel Istanbul</h3>
          <p style="white-space: pre-line;">${result.replyText}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="font-size: 12px; color: #777;">
            <strong>Eliza Hotel Istanbul</strong><br/>
            Mimar Hayrettin Mah. Doğramacı Sk. No:19/5, Fatih / İstanbul<br/>
            Tel: +90 212 520 81 00 | Web: <a href="https://www.elizahotelistanbul.com" style="color: #c5a059;">elizahotelistanbul.com</a>
          </p>
        </div>
      `;

      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Eliza Hotel <onboarding@resend.dev>',
          to: [fromEmail],
          subject: result.subject,
          html: emailHtml
        })
      });

      const resendData = await resendRes.json();
      console.log(' Resend Gönderim Sonucu:', resendData);

      return res.status(200).json({
        success: true,
        decision: result.status,
        subject: result.subject,
        resendId: resendData.id
      });
    } catch (error) {
      console.error('E-Posta API Hatası:', error);
      return res.status(500).json({ error: 'Sunucu hatası oluştu.' });
    }
  }

  return res.status(405).end();
}
