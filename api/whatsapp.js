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

  // 2. WhatsApp Mesajı Yanıtlama & Akıllı Yorum Filtresi
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
Görevin; misafirlerin rezervasyon, oda özellikleri, kahvaltı ve konum sorularını yanıtlamak, aynı zamanda çıkış yapan misafirlerin memnuniyet değerlendirmelerini akıllıca filtrelemektir.

DESTEKLENEN DİLLER:
- Türkçe, İngilizce, Arapça, Rusça, Fransızca, İspanyolca, Çince, Almanca.
- Misafir hangi dilde yazarsa DOĞRUDAN o dilde yanıt ver.

AKILLI GOOGLE YORUM FİLTRESİ (ÇOK ÖNEMLİ):
Misafir bir puan verdiğinde (1 ile 5 arası rakam) veya konaklamasını değerlendiren bir geri bildirim yazdığında:
1. POZİTİF DEĞERLENDİRME (4 VEYA 5 PUAN, "Harikaydı", "Çok memnun kaldık" vb.):
   - Çok sıcak ve içten bir dille teşekkür et.
   - 1 dakikasını ayırıp bunu Google Haritalar'da paylaşmasının otele çok büyük destek olacağını belirt.
   - Doğrudan şu Google Haritalar linkini ver:
     https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul
2. NEGATİF DEĞERLENDİRME (1, 2 VEYA 3 PUAN, Şikayet, Memnuniyetsizlik vb.):
   - KESİNLİKLE GOOGLE LİNKİNİ VERME!
   - Yaşanan aksaklık için içtenlikle özür dile.
   - Durumu otel müdürüne ileteceğini söyle ve neyi eksik yaptığımızı, nasıl telafi edebileceğimizi kısaca sormasını rica et.

OTEL BİLGİLERİ (STANDART SORULAR İÇİN):
- Konsept: "Oda Kahvaltı" (Bed & Breakfast) konseptindedir. Kahvaltı fiyata dahildir.
- Odalar: Double, Twin, Quadruple, Family Room (Klima, TV, Wi-Fi, Minibar, Kettle, Banyo, Saç Kurutma, Balkon, Çalışma Masası, Ütü).
- Rezervasyon Linki: https://www.elizahotelistanbul.com
- İletişim: +90 212 520 81 00
- Konum: Fatih / İstanbul (Beyazıt Tramvayı 250 m, Çemberlitaş Tramvayı 300 m).
- Giriş: 14:00 | Çıkış: 12:00. Otopark YOKTUR. Evcil Hayvan KABUL EDİLMEMEKTEDİR.
- Transfer: Sabiha Gökçen ve İstanbul Havalimanı için ücretli transfer mevcuttur.
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
