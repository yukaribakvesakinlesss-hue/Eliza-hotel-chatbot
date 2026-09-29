// api/email.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Yalnızca POST istekleri kabul edilir.' });
  }

  try {
    const { fromEmail, subject, emailBody } = req.body;

    if (!emailBody || !fromEmail) {
      return res.status(400).json({ error: 'E-posta içeriği veya gönderen adresi eksik.' });
    }

    console.log(` Yeni E-Posta Geldi -> Gönderen: ${fromEmail}, Konu: ${subject}`);

    // Eliza Hotel Çok Dilli E-Posta Sistem Promptu
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

    // 1. OpenAI GPT-4o mini Analizi
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

    // 2. Resend API ile E-Postayı Gönder
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
