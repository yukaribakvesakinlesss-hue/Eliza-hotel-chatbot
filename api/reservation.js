// api/reservation.js - Web sitesinden gelen doğrudan rezervasyonları otele iletir
// index.html içindeki ROOMS ile aynı tutulmalı. price: gecelik € (bilinmiyorsa null)
const ROOMS = {
  single: { title: 'Single Room', capacity: 1, price: null },
  double: { title: 'Standard Double Room', capacity: 2, price: null },
  twin: { title: 'Standard Twin Room', capacity: 2, price: null },
  triple: { title: 'Standard Triple Room', capacity: 3, price: null },
  quad: { title: 'Quadruple Room', capacity: 4, price: null },
  family: { title: 'Family Room', capacity: 5, price: null }
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toUtcDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function makeReference() {
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 5);
  return `ELZ-${stamp}${rand}`;
}

async function sendEmail({ to, subject, html, replyTo }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: process.env.RESERVATION_FROM_EMAIL || 'Eliza Hotel <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Yalnızca POST istekleri kabul edilir.' });
  }

  try {
    const body = req.body || {};
    const room = ROOMS[body.roomId];
    const guests = Number(body.guests);
    const name = String(body.name || '').trim().slice(0, 80);
    const phone = String(body.phone || '').trim().slice(0, 25);
    const email = String(body.email || '').trim().slice(0, 120);
    const note = String(body.note || '').trim().slice(0, 500);
    const lang = body.lang === 'en' ? 'en' : 'tr';

    // --- Sunucu tarafı doğrulama (istemciye güvenme) ---
    if (!room) return res.status(400).json({ success: false, error: 'Geçersiz oda tipi.' });
    if (!DATE_RE.test(body.checkin || '') || !DATE_RE.test(body.checkout || '')) {
      return res.status(400).json({ success: false, error: 'Geçersiz tarih.' });
    }
    const nights = Math.round((toUtcDate(body.checkout) - toUtcDate(body.checkin)) / 86400000);
    const todayUtc = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    // İstanbul ile UTC arasındaki saat farkı için 1 gün tolerans
    if (nights < 1 || nights > 60 || toUtcDate(body.checkin) < todayUtc - 86400000) {
      return res.status(400).json({ success: false, error: 'Geçersiz tarih aralığı.' });
    }
    if (!Number.isInteger(guests) || guests < 1 || guests > room.capacity) {
      return res.status(400).json({ success: false, error: 'Misafir sayısı oda kapasitesine uygun değil.' });
    }
    if (name.length < 3 || phone.replace(/\D/g, '').length < 10 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, error: 'İletişim bilgileri eksik veya hatalı.' });
    }

    if (!process.env.RESEND_API_KEY) {
      console.error('Rezervasyon: RESEND_API_KEY tanımlı değil.');
      return res.status(503).json({ success: false, error: 'Rezervasyon servisi yapılandırılmamış.' });
    }

    const reference = makeReference();
    const total = room.price ? `${(room.price * nights).toFixed(2)} €` : 'Otel tarafından belirlenecek';

    const rows = [
      ['Rezervasyon No', reference],
      ['Ad Soyad', name],
      ['Telefon', phone],
      ['E-posta', email],
      ['Oda', room.title],
      ['Giriş', body.checkin],
      ['Çıkış', body.checkout],
      ['Gece', nights],
      ['Misafir', guests],
      ['Tahmini Tutar', total],
      ['Not', note || '-'],
      ['Dil', lang.toUpperCase()]
    ];

    const hotelHtml = `
      <div style="font-family: Arial, sans-serif; color:#333; max-width:600px;">
        <h2 style="color:#1a2a3a; border-bottom:2px solid #c5a059; padding-bottom:8px;">Yeni Web Rezervasyonu</h2>
        <table style="border-collapse:collapse; width:100%; font-size:14px;">
          ${rows.map(([k, v]) => `<tr><td style="padding:6px 10px; border:1px solid #eee; font-weight:bold; width:160px;">${k}</td><td style="padding:6px 10px; border:1px solid #eee;">${escapeHtml(v)}</td></tr>`).join('')}
        </table>
        <p style="font-size:12px; color:#777;">Misafire onay vermek için bu e-postayı yanıtlayabilir veya WhatsApp ile ulaşabilirsiniz.</p>
      </div>`;

    const hotelEmail = process.env.RESERVATION_NOTIFY_EMAIL || 'info@elizahotelistanbul.com';
    const sent = await sendEmail({
      to: hotelEmail,
      subject: `Yeni Rezervasyon ${reference} - ${name} (${body.checkin} / ${nights} gece)`,
      html: hotelHtml,
      replyTo: email
    });

    // Misafire onay e-postası: başarısız olsa bile rezervasyon otele ulaştığı için hata döndürme
    try {
      const guestHtml = lang === 'tr'
        ? `<div style="font-family: Arial, sans-serif; color:#333; max-width:600px;">
             <h2 style="color:#1a2a3a;">Hotel Eliza Istanbul</h2>
             <p>Sayın ${escapeHtml(name)},</p>
             <p>Rezervasyon talebiniz alınmıştır. Rezervasyon numaranız: <strong>${reference}</strong></p>
             <p>${escapeHtml(room.title)} • ${escapeHtml(body.checkin)} → ${escapeHtml(body.checkout)} (${nights} gece) • ${guests} misafir<br/>${room.price ? `Tahmini tutar: ${total} (ödeme otelde)` : 'Fiyat bilgisi onay e-postasıyla iletilecektir (ödeme otelde).'}</p>
             <p>Ekibimiz kısa süre içinde rezervasyonunuzu onaylayacaktır.</p>
             <p style="font-size:12px; color:#777;">Mimar Hayrettin Mah. Doğramacı Sk. No:19/5, Fatih / İstanbul • +90 212 520 81 00</p>
           </div>`
        : `<div style="font-family: Arial, sans-serif; color:#333; max-width:600px;">
             <h2 style="color:#1a2a3a;">Hotel Eliza Istanbul</h2>
             <p>Dear ${escapeHtml(name)},</p>
             <p>We have received your reservation. Your reservation number is <strong>${reference}</strong>.</p>
             <p>${escapeHtml(room.title)} • ${escapeHtml(body.checkin)} → ${escapeHtml(body.checkout)} (${nights} nights) • ${guests} guest(s)<br/>${room.price ? `Estimated total: ${total} (pay at the hotel)` : 'Your rate will be sent with the confirmation (pay at the hotel).'}</p>
             <p>Our team will confirm your reservation shortly.</p>
             <p style="font-size:12px; color:#777;">Mimar Hayrettin Mah. Doğramacı Sk. No:19/5, Fatih / Istanbul • +90 212 520 81 00</p>
           </div>`;
      await sendEmail({
        to: email,
        subject: lang === 'tr' ? `Rezervasyonunuz Alındı - ${reference}` : `Reservation Received - ${reference}`,
        html: guestHtml,
        replyTo: hotelEmail
      });
    } catch (guestErr) {
      console.warn('Misafir onay e-postası gönderilemedi:', guestErr.message);
    }

    console.log(`Rezervasyon kaydedildi: ${reference} (${sent.id})`);
    return res.status(200).json({ success: true, reference });
  } catch (error) {
    console.error('Rezervasyon API Hatası:', error);
    return res.status(500).json({ success: false, error: 'Rezervasyon iletilemedi.' });
  }
}
