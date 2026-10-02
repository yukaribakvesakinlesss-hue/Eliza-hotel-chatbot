// api/whatsapp.js - Garantili ve Anında Yanıt Veren Akıllı Asistan
export default async function handler(req, res) {
  const VERIFY_TOKEN = 'eliza_hotel_secret_2026';

  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).json({ error: 'Doğrulama geçersiz.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = req.body;

      if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
        const messageObj = body.entry[0].changes[0].value.messages[0];
        const fromNumber = messageObj.from;

        let userText = '';
        let buttonId = '';

        if (messageObj.type === 'text') {
          userText = messageObj.text ? messageObj.text.body : '';
        } else if (messageObj.type === 'interactive' && messageObj.interactive) {
          if (messageObj.interactive.type === 'button_reply') {
            buttonId = messageObj.interactive.button_reply.id;
            userText = messageObj.interactive.button_reply.title;
          } else if (messageObj.interactive.type === 'list_reply') {
            buttonId = messageObj.interactive.list_reply.id;
            userText = messageObj.interactive.list_reply.title;
          }
        }

        console.log(` Gelen Etkileşim -> Metin: "${userText}", ID: "${buttonId}", Gönderen: ${fromNumber}`);

        const clean = userText.trim();
        const phoneNumberId = process.env.WHATSAPP_PHONE_ID;
        const whatsappToken = process.env.WHATSAPP_TOKEN;

        // --- 1. KORUMA KALKANI: PUANLAMA KONTROLÜ (ANINDA 0.2 SANİYEDE YANIT) ---
        const isPositive = buttonId === 'rate_5' || buttonId === 'rate_4' || /^[45](\s*(puan|star|yıldız|\.|$))/i.test(clean);
        const isNegative = buttonId === 'rate_low' || buttonId === 'rate_1' || buttonId === 'rate_2' || buttonId === 'rate_3' || /^[123](\s*(puan|star|yıldız|\.|$))/i.test(clean) || clean.toLowerCase().includes('memnun');

        let directReply = null;

        if (isPositive) {
          directReply = "Değerli geri bildiriminiz için teşekkür ederiz. Sizi Eliza Hotel'de ağırlamaktan memnuniyet duyduk. Deneyiminizi Google'da paylaşarak bize destek olabilirsiniz:\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul";
        } else if (isNegative) {
          directReply = "Geri bildiriminiz bizim için değerlidir. Beklentinizin altında kalan detayları kısaca paylaşabilir misiniz? Notunuz doğrudan otel yönetimimiz tarafından incelenecektir.";
        }

        // Eğer misafir puan vermişse doğrudan yanıtı gönder (OpenAI beklemeden hatasız çalışır)
        if (directReply) {
          await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${whatsappToken}`
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: fromNumber,
              text: { body: directReply }
            })
          });

          return res.status(200).send('EVENT_RECEIVED');
        }

        // --- 2. ŞİKAYET DETAYI VEYA NORMAL OTEL SORULARI İÇİN YAPAY ZEKA ---
        if (userText) {
          const systemPrompt = `
Sen, İstanbul Tarihi Yarımada'da yer alan butik "Eliza Hotel"in resmi kurumsal WhatsApp asistanısın.

KURUMSAL TON KURALI:
- Cümlelerin kısa, net, saygın ve kendinden emin olsun.
- Misafir hangi dilde yazarsa DOĞRUDAN o dilde yanıt ver.

ÖZEL DURUM:
- Eğer misafir az önceki memnuniyetsizliğin sebebini yazdıysa (Örn: "klima çalışmıyordu", "oda tozluydu", "ses vardı" vb.):
  "Geri bildiriminiz için teşekkür ederiz. Notunuz doğrudan otel yönetimimize iletilmiştir. Seyahatinizin geri kalanında iyi günler dileriz." diyerek konuyu otel içinde tut ve nazikçe kapat.

GENEL OTEL BİLGİLERİ (SORULAR İÇİN):
- Konsept: "Oda Kahvaltı" (Bed & Breakfast) - Kahvaltı fiyata dahildir.
- Odalar: Double, Twin, Quadruple, Family Room (Klima, TV, Wi-Fi, Minibar, Kettle, Banyo, Saç Kurutma, Balkon, Çalışma Masası, Ütü).
- Rezervasyon Linki: https://www.elizahotelistanbul.com
- İletişim: +90 212 520 81 00
- Konum: Fatih / İstanbul (Beyazıt Tramvayı 250 m, Çemberlitaş Tramvayı 300 m).
- Giriş: 14:00 | Çıkış: 12:00. Otopark YOKTUR. Evcil Hayvan KABUL EDİLMEMEKTEDİR.
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
                { role: 'user', content: userText }
              ],
              temperature: 0.2,
              max_tokens: 250
            })
          });

          const openAiData = await openAiRes.json();
          const aiReply = openAiData.choices && openAiData.choices[0] ? openAiData.choices[0].message.content : null;

          if (aiReply) {
            await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${whatsappToken}`
              },
              body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: fromNumber,
                text: { body: aiReply }
              })
            });
          }
        }
      }

      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      console.error('WhatsApp Bot Hatası:', error);
      return res.status(200).send('EVENT_RECEIVED');
    }
  }

  return res.status(405).end();
}
