// api/email.js
export default async function handler(req, res) {
  // Yalnızca POST isteklerini kabul et
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
Görevin; misafirlerden veya acentelerden gelen e-postaları okumak, analiz etmek ve yanıtlamaktır.

DESTEKLENEN DİLLER:
- Türkçe, İngilizce, Arapça, Rusça, Fransızca, İspanyolca, Çince, Almanca.
- Gelen e-posta hangi dilde yazılmışsa KESİNLİKLE o dilde kurumsal, nazik ve profesyonel bir yanıt oluştur.

AKILLI AYRIM KURALI:
1. STANDART SORULAR:
   - Kahvaltı dahil mi, check-in (14:00) / check-out (12:00) saatleri, Wi-Fi, havalimanı transferi, konum, oda olanakları, rezervasyon linki.
   - Aksiyon: "STATUS: AUTO_REPLY" etiketi koy ve misafire doğrudan gönderilecek eksiksiz, nazik bir kurumsal yanıt yaz.
2. ÖZEL TALEPLER (İNSAN ONAYI GEREKENLER):
   - Grup rezervasyonu (birden fazla oda/kalabalık), acente anlaşması, özel fiyat pazarlığı, şirket faturası, şikayet.
   - Aksiyon: "STATUS: NEEDS_REVIEW" etiketi koy. Resepsiyon personelinin incelemesi için özel bir taslak not oluştur.

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

    // OpenAI GPT-4o mini'ye Gönder
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
          { role: 'user', content: `Gelen E-posta Konusu: ${subject}\n\nİçerik:\n${emailBody}` }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      })
    });

    const openAiData = await openAiRes.json();
    const result = JSON.parse(openAiData.choices[0].message.content);

    console.log(' E-Posta Yanıtı Hazırlandı:', result);

    return res.status(200).json({
      success: true,
      decision: result.status,
      subject: result.subject,
      reply: result.replyText
    });
  } catch (error) {
    console.error('E-Posta API Hatası:', error);
    return res.status(500).json({ error: 'Sunucu hatası oluştu.' });
  }
}
