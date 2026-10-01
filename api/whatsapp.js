// api/whatsapp.js - Üst Düzey Kurumsal ve Akıllı WhatsApp Asistanı
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
        } else if (messageObj.type === 'interactive' && messageObj.interactive && messageObj.interactive.type === 'button_reply') {
          buttonId = messageObj.interactive.button_reply.id;
          userText = messageObj.interactive.button_reply.title;
        }

        console.log(` Gelen Etkileşim -> Metin: "${userText}", Buton ID: "${buttonId}", Gönderen: ${fromNumber}`);

        if (userText || buttonId) {
          const systemPrompt = `
Sen, İstanbul Tarihi Yarımada'da yer alan butik "Eliza Hotel"in kurumsal ve profesyonel WhatsApp asistanısın.

KURUMSAL TON KURALI:
- Asla gereksiz samimiyete girme veya aşırı ezilip büzülme. Ağırbaşlı, lüks butik otel standardında, net ve kendinden emin konuş.
- Cümlelerin kısa ve öz olsun (en fazla 2-3 cümle).
- Misafir hangi dilde yazarsa DOĞRUDAN o dilde yanıt ver.

AKILLI ANKET VE YORUM YÖNETİMİ:
1. POZİTİF DEĞERLENDİRME (rate_5 veya rate_4 tıklandıysa):
   - Kısa ve net teşekkür et.
   - Google Haritalar linkini MUTLAKA mesajın EN ALTINDA, tek başına bir satırda ver.
   - Örnek Format:
"Değerli geri bildiriminiz için teşekkür ederiz. Sizi Eliza Hotel'de ağırlamaktan memnuniyet duyduk. Deneyiminizi Google'da paylaşarak bize destek olabilirsiniz:

👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul"

2. NEGATİF DEĞERLENDİRME (rate_low tıklandıysa):
   - KESİNLİKLE GOOGLE LİNKİNİ VERME!
   - Saygın ve net ol.
   - Format:
"Geri bildiriminiz bizim için değerlidir. Beklentinizin altında kalan detayları kısaca paylaşabilir misiniz? Notunuz doğrudan otel yönetimimiz tarafından incelenecektir."

3. MİSAFİR ŞİKAYET SEBEBİNİ YAZDIĞINDA:
   - Kısa ve kurumsal kapat:
"Görüşleriniz otel yönetimimize iletilmiştir. Zaman ayırdığınız için teşekkür eder, iyi günler dileriz."

GENEL OTEL BİLGİLERİ (STANDART SORULAR İÇİN):
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
                { role: 'user', content: buttonId ? `Kullanıcı şu butona tıkladı: [ID: ${buttonId}, Başlık: ${userText}]` : userText }
              ],
              temperature: 0.2,
              max_tokens: 250
            })
          });

          const openAiData = await openAiRes.json();
          const aiReply = openAiData.choices && openAiData.choices[0] ? openAiData.choices[0].message.content : null;

          if (aiReply) {
            const phoneNumberId = process.env.WHATSAPP_PHONE_ID;
            const whatsappToken = process.env.WHATSAPP_TOKEN;

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
