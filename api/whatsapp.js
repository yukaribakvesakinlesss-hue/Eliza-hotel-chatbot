// api/whatsapp.js - Kesin Dil Kilitli WhatsApp Asistanı
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

        // --- 1. HATASIZ DİL TESPİTİ (ASLA TÜRKÇEYE KAYMAZ) ---
        function getStrictLanguage(btnId, text) {
          const b = String(btnId || '').toLowerCase();
          const t = String(text || '');

          // Buton ID'sinden kesin tespit
          if (b.includes('_ar') || /[\u0600-\u06FF]|[\u0750-\u077F]|[٠-٩]/.test(t)) return 'ar';
          if (b.includes('_zh') || /[\u4e00-\u9fa5]/.test(t)) return 'zh';
          if (b.includes('_ru') || /[\u0400-\u04FF]/.test(t)) return 'ru';
          if (b.includes('_fr') || /très|satisfait|merci|bonjour/i.test(t)) return 'fr';
          if (b.includes('_es') || /muy|bueno|satisfecho|gracias|hola/i.test(t)) return 'es';
          if (b.includes('_de') || /vielen|sehr|nicht|danke|gut/i.test(t)) return 'de';
          if (b.includes('_tr') || /harika|mükemmel|teşekkür|puan|memnun/i.test(t)) return 'tr';
          if (b.includes('_en') || /excel|good|star|rate|low|thank/i.test(t)) return 'en';

          return 'en'; // Kesinlikle tr DEĞİL, uluslararası standart İngilizce!
        }

        const lang = getStrictLanguage(buttonId, clean);

        // --- 2. 8 DİLDE KUSURSUZ YANIT METİNLERİ ---
        const templates = {
          ar: {
            pos: "شكراً جزيلاً لملاحظاتكم القيمة. يسعدنا دائماً استضافتكم في فندق إليزا. نرجو منكم مشاركة تجربتكم على خرائط جوجل لدعمنا:\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "ملاحظاتكم مهمة جداً بالنسبة لنا. هل يمكنك تزويدنا بتفاصيل ما لم يلقَ استحسانكم باختصار؟ سيتم مراجعة ملاحظتك مباشرة من قِبل إدارة الفندق."
          },
          zh: {
            pos: "非常感谢您的宝贵评价！非常荣幸能在伊丽莎酒店（Eliza Hotel）接待您。如果您能在谷歌地图上分享您的入住体验，我们将不胜感激：\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "您的反馈对我们非常重要。能否请您简要说明哪些方面未能达到您的期望？您的意见将直接呈交酒店管理层进行核实。"
          },
          en: {
            pos: "Thank you for your valuable feedback. It was a pleasure hosting you at Eliza Hotel. You can support us by sharing your experience on Google:\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "Your feedback is valuable to us. Could you briefly share what fell short of your expectations? Your note will be reviewed directly by our management."
          },
          ru: {
            pos: "Благодарим за ваш ценный отзыв! Нам было приятно принимать вас в Eliza Hotel. Вы можете поддержать нас, поделившись впечатлениями в Google:\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "Ваш отзыв очень важен для нас. Пожалуйста, кратко опишите, что не оправдало ваших ожиданий. Ваше сообщение будет передано руководству отеля."
          },
          fr: {
            pos: "Merci beaucoup pour votre retour. Ce fut un plaisir de vous accueillir à Eliza Hotel. Vous pouvez nous soutenir en partageant votre expérience sur Google :\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "Votre avis est précieux pour nous. Pourriez-vous nous indiquer brièvement ce qui n'a pas répondu à vos attentes ? Votre remarque sera directement transmise à la direction."
          },
          es: {
            pos: "Muchas gracias por sus amables comentarios. Fue un placer hospedarle en Eliza Hotel. Puede apoyarnos compartiendo su experiencia en Google:\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "Sus comentarios son muy valiosos para nosotros. ¿Podría compartir brevemente en qué no cumplimos sus expectativas? Su nota será revisada directamente por la dirección."
          },
          de: {
            pos: "Vielen Dank für Ihre wertvolle Rückmeldung. Es war uns eine Freude, Sie im Eliza Hotel zu begrüßen. Unterstützen Sie uns gerne mit einer Bewertung auf Google:\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "Ihr Feedback ist uns sehr wichtig. Könnten Sie uns kurz mitteilen, was nicht Ihren Erwartungen entsprochen hat? Ihre Anmerkung wird direkt an die Geschäftsleitung weitergeleitet."
          },
          tr: {
            pos: "Değerli geri bildiriminiz için teşekkür ederiz. Sizi Eliza Hotel'de ağırlamaktan memnuniyet duyduk. Deneyiminizi Google'da paylaşarak bize destek olabilirsiniz:\n\n👉 https://www.google.com/maps/search/?api=1&query=Eliza+Hotel+Mimar+Hayrettin+Fatih+Istanbul",
            neg: "Geri bildiriminiz bizim için değerlidir. Beklentinizin altında kalan detayları kısaca paylaşabilir misiniz? Notunuz doğrudan otel yönetimimiz tarafından incelenecektir."
          }
        };

        const isPositive = buttonId.startsWith('rate_5') || buttonId.startsWith('rate_4') || /^[45٤٥](\s*(puan|star|yıldız|نجوم|баллов|\.|$))/i.test(clean);
        const isNegative = buttonId.startsWith('rate_low') || /^[123١٢٣](\s*(puan|star|yıldız|نجمة|баллов|\.|$))/i.test(clean) || clean.toLowerCase().includes('memnun değil') || clean.toLowerCase().includes('bad') || clean.toLowerCase().includes('poor') || clean.toLowerCase().includes('غير راض');

        let directReply = null;
        const currentLangTemplates = templates[lang] || templates['en'];

        if (isPositive) {
          directReply = currentLangTemplates.pos;
        } else if (isNegative) {
          directReply = currentLangTemplates.neg;
        }

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

        // --- 3. ŞİKAYET DETAYI VE GENEL SORULAR İÇİN YAPAY ZEKA ---
        if (userText) {
          const systemPrompt = `
Sen, İstanbul Tarihi Yarımada'da yer alan butik "Eliza Hotel"in resmi kurumsal WhatsApp asistanısın.

KESİN DİL KURALI (EN KATI VE İHLAL EDİLEMEZ KURAL):
- Misafir hangi dilde yazmışsa KESİNLİKLE VE SADECE O DİLDE YANIT VER!
- Arapça yazıldıysa KESİNLİKLE Arapça yanıt ver.
- Çince yazıldıysa KESİNLİKLE Çince yanıt ver.
- Rusça yazıldıysa KESİNLİKLE Rusça yanıt ver.
- İngilizce ise İngilizce, Fransızca ise Fransızca yanıt ver.
- Asla gelen dilin dışında (örneğin Türkçe) cevap verme!

ÖZEL DURUM:
- Eğer misafir az önceki memnuniyetsizliğin sebebini yazdıysa:
  Gelen dilde "Geri bildiriminiz için teşekkür ederiz. Notunuz doğrudan otel yönetimimize iletilmiştir. İyi günler dileriz." anlamında kurumsal ve nazik bir yanıt ver.

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
              temperature: 0.1,
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
