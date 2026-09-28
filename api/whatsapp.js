// api/whatsapp.js
export default async function handler(req, res) {
  const VERIFY_TOKEN = 'eliza_hotel_secret_2026';

  // 1. Meta Webhook Doğrulama
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).json({ error: 'Doğrulama belirteci geçersiz.' });
    }
  }

  // 2. WhatsApp Mesajı Yanıtlama
  if (req.method === 'POST') {
    try {
      const body = req.body;

      if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
        const messageObj = body.entry[0].changes[0].value.messages[0];
        const fromNumber = messageObj.from;
        const userText = messageObj.text ? messageObj.text.body : '';

        console.log(` WhatsApp'tan Mesaj Geldi: "${userText}" - Gönderen: ${fromNumber}`);

        if (userText) {
          const systemPrompt = `
Sen, İstanbul Tarihi Yarımada'da yer alan butik "Eliza Hotel"in resmi çok dilli WhatsApp misafir asistanısın.
Görevin; misafirlerin rezervasyon, oda özellikleri, kahvaltı, iptal koşulları, ulaşım ve konum hakkındaki sorularını nazik, kurumsal ve %100 doğru şekilde yanıtlamaktır.

DESTEKLENEN DİLLER:
- Türkçe, İngilizce, Arapça, Rusça, Fransızca, İspanyolca, Çince, Almanca.
- Misafir hangi dilde yazarsa DOĞRUDAN o dilde yanıt ver.

KAHVALTI VE YEMEK:
- Konaklamalar "Oda Kahvaltı" (Bed & Breakfast) konseptindedir. Kahvaltı fiyata dahildir.

ODA VE DONANIMLAR:
- Oda Tipleri: Standard Double Room, Standard Twin Room, Quadruple Room, Family Room.
- Donanımlar: Klima, Isıtma, Düz Ekran TV, Ücretsiz Wi-Fi, Minibar, Kahve Makinesi, Kettle, Banyo & Duş, Saç Kurutma, Havlu, Terlik, Balkon, Çalışma Masası, Ütü olanakları.

REZERVASYON VE LİNK:
- Fiyat veya rezervasyon sorulduğunda şu resmi linki ver: https://www.elizahotelistanbul.com
- Telefonla rezervasyon için: +90 212 520 81 00

GENEL BİLGİLER:
- Konum: Fatih / İstanbul (Beyazıt Tramvayı 250 m, Çemberlitaş Tramvayı 300 m).
- Giriş: 14:00 | Çıkış: 12:00. Otopark YOKTUR. Evcil Hayvan KABUL EDİLMEMEKTEDİR.
- Transfer: Havalimanları için ücretli transfer mevcuttur.
`;

          // OpenAI Çağrısı
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
              temperature: 0.3,
              max_tokens: 500
            })
          });

          const openAiData = await openAiRes.json();
          const aiReply = openAiData.choices && openAiData.choices[0] ? openAiData.choices[0].message.content : null;

          console.log(' OpenAI Yanıtı Hazır:', aiReply);

          if (aiReply) {
            const phoneNumberId = process.env.WHATSAPP_PHONE_ID;
            const whatsappToken = process.env.WHATSAPP_TOKEN;

            console.log(` Meta WhatsApp Gönderiliyor... (PhoneID: ${phoneNumberId})`);

            const metaRes = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
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

            const metaData = await metaRes.json();
            console.log(' Meta WhatsApp Yanıt Sonucu:', metaRes.status, JSON.stringify(metaData));
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
