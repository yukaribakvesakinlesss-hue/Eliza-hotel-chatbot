/* AXON Systems site script. Built by tools/axon-site/build.py into axon/assets/app.js */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var WHATSAPP = '905540248698', EMAIL = '__EMAIL__';
  var GA4_ID = '__GA4__';            // set via AXON_GA4 when building; empty = analytics off
  var ENGINE = __ENGINE__;           // booking-engine strings (en, tr)
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lang = 'en';

  /* ================= Analytics (GA4, consent-gated, no personal data) ================= */
  window.dataLayer = window.dataLayer || [];
  var gaOn = false;
  function track(name, params) {
    var p = params || {}; p.page_language = lang;
    if (gaOn && window.gtag) window.gtag('event', name, p);
  }
  function loadGA() {
    if (!GA4_ID || gaOn) return; gaOn = true;
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date()); window.gtag('config', GA4_ID, { anonymize_ip: true });
    var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA4_ID); document.head.appendChild(s);
  }
  if (GA4_ID) {
    var c = null; try { c = localStorage.getItem('axonConsent'); } catch (e) {}
    if (c === 'yes') loadGA();
    else if (c !== 'no') {
      $('#consent').hidden = false;
      $('#consentYes').onclick = function () { try { localStorage.setItem('axonConsent', 'yes'); } catch (e) {} $('#consent').hidden = true; loadGA(); };
      $('#consentNo').onclick = function () { try { localStorage.setItem('axonConsent', 'no'); } catch (e) {} $('#consent').hidden = true; };
    }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a, button'); if (!a) return;
    if (a.hasAttribute('data-cta')) track('demo_cta_click', { location: a.getAttribute('data-cta-loc') || '' });
    if (a.classList.contains('pkg-cta')) track('pricing_cta_click', { package: a.getAttribute('data-pkg') });
    if (a.classList.contains('wa-link')) track('whatsapp_click', {});
  });

  /* ================= Language (EN default, TR) ================= */
  var saved = null; try { saved = localStorage.getItem('axonLang'); } catch (e) {}
  if (saved === 'en' || saved === 'tr') lang = saved;
  else if ((navigator.language || '').toLowerCase().indexOf('tr') === 0) lang = 'tr';
  var listeners = [];
  function L(en, tr) { return lang === 'tr' ? tr : en; }
  function applyLang(l) {
    lang = l; document.documentElement.lang = l;
    try { localStorage.setItem('axonLang', l); } catch (e) {}
    $$('[data-tr]').forEach(function (el) {
      if (el.dataset.en == null) el.dataset.en = el.textContent;
      el.textContent = l === 'tr' ? el.dataset.tr : el.dataset.en;
    });
    $$('[data-tr-ph]').forEach(function (el) {
      if (el.dataset.enPh == null) el.dataset.enPh = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', l === 'tr' ? el.dataset.trPh : el.dataset.enPh);
    });
    $$('[data-tr-aria]').forEach(function (el) {
      if (el.dataset.enAria == null) el.dataset.enAria = el.getAttribute('aria-label') || '';
      el.setAttribute('aria-label', l === 'tr' ? el.dataset.trAria : el.dataset.enAria);
    });
    $$('.lang-b').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === l)); });
    $$('.wa-link').forEach(function (a) { if (!a.dataset.fixed) a.href = 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(L('Hello AXON, I would like to learn more about AXON Hotel AI for our hotel.', 'Merhaba AXON, otelimiz için AXON Hotel AI hakkında bilgi almak istiyorum.')); });
    listeners.forEach(function (fn) { fn(); });
  }
  $$('.lang-b').forEach(function (b) { b.addEventListener('click', function () { applyLang(b.dataset.lang); }); });
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }

  /* ================= Theme (dark default, light optional) ================= */
  function setTheme(light, save) {
    document.documentElement.classList.toggle('light', light);
    if (save) { try { localStorage.setItem('axonTheme', light ? 'light' : 'dark'); } catch (e) {} }
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', light ? '#FFFFFF' : '#0B1423');
    var b = $('#themeToggle');
    if (b) { b.setAttribute('aria-label', light ? L('Switch to dark mode', 'Koyu temaya geç') : L('Switch to light mode', 'Açık temaya geç')); b.dataset.enAria = b.getAttribute('aria-label'); b.dataset.trAria = b.getAttribute('aria-label'); }
    window.dispatchEvent(new CustomEvent('axon-theme', { detail: { light: light } }));
  }
  $('#themeToggle').addEventListener('click', function () { setTheme(!document.documentElement.classList.contains('light'), true); });
  listeners.push(function () { setTheme(document.documentElement.classList.contains('light'), false); });

  /* ================= Reveal + active nav ================= */
  if ('IntersectionObserver' in window && !reduce) {
    document.documentElement.classList.add('js-reveal');
    var ro = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); } }); }, { rootMargin: '0px 0px -6% 0px' });
    $$('.reveal').forEach(function (el) { ro.observe(el); });
  }
  if ('IntersectionObserver' in window) {
    var navA = $$('.nav-a');
    var no = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) navA.forEach(function (a) { var on = a.getAttribute('href') === '#' + e.target.id; a.classList.toggle('text-ink', on); a.classList.toggle('text-mist', !on); }); });
    }, { rootMargin: '-40% 0px -55% 0px' });
    navA.forEach(function (a) { var s = $(a.getAttribute('href')); if (s) no.observe(s); });
  }
  if (reduce) $$('animateMotion').forEach(function (m) { m.remove(); });

  /* ================= 03 Solutions ================= */
  var SOL = [
    ['AI Guest Assistant', 'Yapay zekâ misafir asistanı', 'Answers questions about rooms, policies, facilities and the area from your hotel\'s own information.', 'Oda, kural, olanak ve çevre sorularını otelinizin kendi bilgileriyle cevaplar.', 'Unanswered and late replies.', 'Cevapsız kalan ve geciken mesajlar.', 'Every guest gets a correct first answer, day or night.', 'Her misafir gece gündüz doğru bir ilk cevap alır.'],
    ['Website Chat Automation', 'Web sitesi sohbet otomasyonu', 'A chat window on your site that greets visitors, answers them and guides them to an inquiry.', 'Sitenizde ziyaretçiyi karşılayan, cevaplayan ve talebe yönlendiren sohbet penceresi.', 'Visitors who leave without contacting you.', 'İletişime geçmeden siteden çıkan ziyaretçiler.', 'Website traffic turns into conversations your team can follow up.', 'Site trafiği, ekibinizin takip edebileceği konuşmalara dönüşür.'],
    ['WhatsApp Integration', 'WhatsApp entegrasyonu', 'Connects the assistant to your WhatsApp Business number through the official WhatsApp Business Platform.', 'Asistanı resmi WhatsApp Business Platform üzerinden WhatsApp Business numaranıza bağlar.', 'Messages piling up on one phone at reception.', 'Resepsiyondaki tek telefonda biriken mesajlar.', 'Guests reach you on the app they already use every day.', 'Misafir size her gün kullandığı uygulamadan ulaşır.'],
    ['Multilingual Communication', 'Çok dilli iletişim', 'Detects the guest\'s language and replies in it. Your team reads the conversation in theirs.', 'Misafirin dilini algılar ve o dilde cevaplar. Ekibiniz konuşmayı kendi dilinde okur.', 'Language barriers with international guests.', 'Yabancı misafirlerle dil engeli.', 'International guests feel understood from the first message.', 'Yabancı misafir ilk mesajdan itibaren anlaşıldığını hisseder.'],
    ['Lead Capture & Qualification', 'Talep toplama ve ön eleme', 'Collects dates, guests, room preference and contact details during the conversation.', 'Tarih, kişi sayısı, oda tercihi ve iletişim bilgisini sohbet sırasında toplar.', 'Incomplete inquiries that need many back-and-forth messages.', 'Defalarca yazışma gerektiren eksik talepler.', 'Your team receives requests that are ready to quote.', 'Ekibinize fiyat vermeye hazır talepler ulaşır.'],
    ['Reservation Inquiry Management', 'Rezervasyon talebi yönetimi', 'Structures each request and sends it to your team or reservation inbox with every detail in one place.', 'Her talebi düzenler ve tüm detaylarıyla ekibinize ya da rezervasyon e-posta kutunuza iletir.', 'Requests scattered across email, chat and phone notes.', 'E-posta, sohbet ve not kâğıtlarına dağılmış talepler.', 'Nothing gets lost between shifts.', 'Vardiya değişiminde hiçbir talep kaybolmaz.'],
    ['CRM Integration', 'CRM entegrasyonu', 'Sends inquiries and contact details to the CRM or spreadsheet you already use, where an API or import is available.', 'Talepleri ve iletişim bilgilerini, API veya aktarım imkânı olan CRM ya da tablonuza gönderir.', 'Copying guest data by hand.', 'Misafir bilgisini elle kopyalamak.', 'Clean guest records for follow-up and repeat stays.', 'Takip ve tekrar konaklama için düzenli misafir kayıtları.'],
    ['Human Support Handover', 'Ekibe devir', 'When a question needs a person, the assistant hands the conversation to your team with the full context.', 'Bir soru insan gerektirdiğinde asistan konuşmayı tüm geçmişiyle ekibinize devreder.', 'Guests stuck with an assistant that cannot help.', 'Yardım alamayan bir asistanla baş başa kalan misafir.', 'AI handles the routine; your staff handle the moments that matter.', 'Rutin işi yapay zekâ, önemli anları ekibiniz üstlenir.']
  ];
  function renderSol() {
    $('#solGrid').innerHTML = SOL.map(function (s, i) {
      return '<article class="card flex flex-col p-7"><span class="font-display text-[13px] font-semibold text-gold">' + ('0' + (i + 1)).slice(-2) + '</span>' +
        '<h3 class="mt-4 font-display text-[18px] font-semibold text-ink">' + esc(L(s[0], s[1])) + '</h3>' +
        '<p class="mt-3 text-[14.5px] leading-relaxed text-ink/85">' + esc(L(s[2], s[3])) + '</p>' +
        '<dl class="mt-5 grid gap-3 border-t border-white/[0.07] pt-5 text-[13.5px] leading-relaxed">' +
        '<div><dt class="font-semibold text-silver">' + L('Solves', 'Çözdüğü sorun') + '</dt><dd class="mt-0.5">' + esc(L(s[4], s[5])) + '</dd></div>' +
        '<div><dt class="font-semibold text-silver">' + L('Why it matters', 'Neden önemli') + '</dt><dd class="mt-0.5">' + esc(L(s[6], s[7])) + '</dd></div></dl></article>';
    }).join('');
  }
  void renderSol; // systems are now static markup in page.html

  /* ================= Packages (Dolunay-style item lists) ================= */
  var CHK = '<svg class="mt-0.5 h-5 w-5 flex-none text-gold" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0z" clip-rule="evenodd"/></svg>';
  var PKG = {
    start: [['Website AI assistant', 'Web sitesi yapay zekâ asistanı'], ['Basic FAQ automation', 'Temel SSS otomasyonu'], ['Guest inquiry collection', 'Misafir talebi toplama'], ['24/7 monitoring and outage alerts', '7/24 çalışma takibi ve kesinti bildirimi'], ['Bug fixes and repairs', 'Hata müdahalesi ve onarım'], ['Model and API updates applied', 'Model ve API güncellemelerinin uygulanması'], ['Monthly performance report', 'Aylık performans raporu'], ['Email support, reply within 2 business days', 'E-posta destek, iki iş günü içinde dönüş']],
    pro: [['Everything in Start', 'Start paketindeki her şey'], ['WhatsApp integration', 'WhatsApp entegrasyonu'], ['Multilingual communication', 'Çok dilli iletişim'], ['CRM integration and reservation inquiry workflows', 'CRM entegrasyonu ve rezervasyon talep akışları'], ['Server, API and AI usage included', 'Sunucu, API ve yapay zekâ kullanım bedeli dahil'], ['New scenarios and improvements every month', 'Her ay yeni senaryo ve iyileştirme'], ['Weekly performance report', 'Haftalık performans raporu'], ['WhatsApp support line, same-day reply', 'WhatsApp destek hattı, aynı gün dönüş']],
    suite: [['Everything in Pro', 'Pro paketindeki her şey'], ['AXON Hotel PMS: room status, reservations, tape chart', 'AXON Otel PMS: oda durumu, rezervasyonlar, doluluk tablosu'], ['Overbooking protection built into the database', 'Veritabanı düzeyinde çakışma (overbooking) koruması'], ['Housekeeping on the phone, with inspection', 'Telefondan housekeeping ve kat şefi onayı'], ['Folio, night audit, ADR, RevPAR and occupancy reports', 'Folyo, gece denetimi, ADR, RevPAR ve doluluk raporları'], ['Guest CRM with KVKK tools', 'KVKK araçlarıyla misafir CRM'], ['AI inbox: WhatsApp, Instagram and web chat with verified prices', 'AI inbox: WhatsApp, Instagram ve web sohbet, doğrulanmış fiyatlarla'], ['Booking.com and Expedia sync (through a certified channel connection)', 'Booking.com ve Expedia senkronizasyonu (sertifikalı kanal bağlantısıyla)'], ['Audit log, roles and daily backups', 'Denetim kaydı, rol bazlı yetkiler ve günlük yedek'], ['Staff training and go-live support', 'Ekip eğitimi ve geçiş desteği']],
    ent: [['Everything in Pro', 'Pro paketindeki her şey'], ['Multiple properties and teams', 'Birden fazla tesis ve ekip'], ['Custom integrations and workflows', 'Özel entegrasyonlar ve iş akışları'], ['Your own development roadmap', 'Size özel geliştirme takvimi'], ['Defined response-time commitment (SLA)', 'Tanımlı yanıt süresi taahhüdü (SLA)'], ['Dedicated project manager', 'Adanmış proje yöneticisi'], ['Monthly review meeting', 'Aylık değerlendirme toplantısı']]
  };
  function renderPkg() {
    $$('[data-pkg-list]').forEach(function (ul) {
      ul.innerHTML = PKG[ul.getAttribute('data-pkg-list')].map(function (x) { return '<li class="flex gap-3">' + CHK + '<span>' + esc(L(x[0], x[1])) + '</span></li>'; }).join('');
    });
  }
  listeners.push(renderPkg);

  /* ================= Loss calculator (visitor's own numbers) ================= */
  var calcIn = ['c1', 'c2', 'c3', 'c4'].map(function (id) { return $('#' + id); });
  function nf(v) { return Math.round(v).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US'); }
  function money(v) { return '$' + nf(v); }
  var calcTouched = false;
  function renderCalc() {
    var q = calcIn.map(function (i) { return +i.value; });
    calcIn.forEach(function (i) { i.style.setProperty('--p', ((i.value - i.min) / (i.max - i.min) * 100) + '%'); });
    $('#cv1').textContent = nf(q[0]);
    $('#cv2').textContent = L(q[1] + '%', '%' + q[1]);
    $('#cv3').textContent = L(q[2] + '%', '%' + q[2]);
    $('#cv4').textContent = money(q[3]);
    var lost = q[0] * q[1] / 100 * q[2] / 100;
    $('#cLost').textContent = lost < 10 ? String(Math.round(lost * 10) / 10).replace('.', lang === 'tr' ? ',' : '.') : nf(lost);
    $('#cMonth').textContent = money(lost * q[3]);
    $('#cYear').textContent = money(lost * q[3] * 12);
  }
  calcIn.forEach(function (i) {
    i.addEventListener('input', function () {
      renderCalc();
      if (!calcTouched) { calcTouched = true; track('live_demo_interaction', { first_action: 'loss_calculator' }); }
    });
  });
  listeners.push(renderCalc);

  /* ================= 04 Workflow ================= */
  var FLOW = [
    ['Guest Inquiry', 'Misafir talebi', 'Website, WhatsApp or email', 'Web sitesi, WhatsApp veya e-posta', '“Double room, Dec 15–18?”', '“15–18 Aralık çift kişilik oda?”'],
    ['AI Assistant', 'Yapay zekâ asistanı', 'Understands and replies in the guest\'s language', 'Anlar ve misafirin dilinde cevaplar', 'Replies instantly · EN', 'Anında cevap · TR'],
    ['Guest Qualification', 'Ön eleme', 'Asks for the missing details', 'Eksik bilgileri sorar', '2 adults · Double', '2 yetişkin · Çift kişilik'],
    ['Lead / Reservation Request', 'Talep / rezervasyon isteği', 'Builds one structured request', 'Tek, düzenli bir talep oluşturur', 'Name · email · dates', 'Ad · e-posta · tarihler'],
    ['Hotel Team', 'Otel ekibi', 'Confirms, prices and follows up', 'Onaylar, fiyat verir, takip eder', 'Front desk notified', 'Resepsiyon bilgilendirildi']
  ];
  function renderFlow() {
    $('#flow').innerHTML = FLOW.map(function (f, i) {
      var last = i === FLOW.length - 1;
      return '<li class="relative flex gap-5 lg:flex-col lg:items-center lg:gap-0 lg:px-3 lg:text-center">' +
        (last ? '' : '<span class="conn" style="--d:' + (i * 0.7) + 's" aria-hidden="true"></span>') +
        '<span class="relative z-10 grid h-14 w-14 flex-none place-items-center rounded-full border ' + (last ? 'border-gold/60 bg-navy-800 text-gold' : 'border-white/15 bg-navy-800 text-silver') + ' font-display text-[14px] font-semibold">' + (i + 1) + '</span>' +
        '<div class="pb-10 pt-1 lg:mt-5 lg:pb-0 lg:pt-0"><h3 class="font-display text-[16px] font-semibold text-ink">' + esc(L(f[0], f[1])) + '</h3><p class="mt-1.5 text-[13.5px] leading-relaxed">' + esc(L(f[2], f[3])) + '</p>' +
        '<p class="mt-3 inline-block rounded-lg border border-white/[0.08] bg-navy-950/60 px-2.5 py-1.5 font-mono text-[11.5px] text-gold/90">' + esc(L(f[4], f[5])) + '</p></div></li>';
    }).join('');
  }
  listeners.push(renderFlow);

  /* ================= 10 FAQ ================= */
  var FAQ = [
    ['What exactly does AXON do?', 'AXON tam olarak ne yapıyor?', 'We design, set up and maintain AI systems for hotels. In practice that is a guest assistant on your website and WhatsApp that answers questions, collects reservation inquiries and passes them to your team, plus the reporting around it.', 'Oteller için yapay zekâ sistemleri tasarlar, kurar ve bakımını yaparız. Pratikte bu; web sitenizde ve WhatsApp\'ta soruları cevaplayan, rezervasyon taleplerini toplayıp ekibinize ileten bir misafir asistanı ve buna bağlı raporlamadır.'],
    ['How does the AI assistant work?', 'Yapay zekâ asistanı nasıl çalışıyor?', 'It uses a large language model that is instructed with your hotel\'s own information: rooms, policies, facilities and frequent questions. It answers within those boundaries, asks for the details an inquiry needs and hands over to your team when a question goes beyond them.', 'Otelinizin kendi bilgileriyle (odalar, kurallar, olanaklar, sık sorular) yönlendirilen büyük bir dil modeli kullanır. Bu sınırlar içinde cevap verir, talep için gereken bilgileri sorar ve sınırın dışına çıkan sorularda ekibinize devreder.'],
    ['Can it communicate in multiple languages?', 'Birden fazla dilde iletişim kurabilir mi?', 'Yes. It detects the language the guest writes in and replies in that language. Before launch we test the languages that matter most for your guests.', 'Evet. Misafirin yazdığı dili algılar ve o dilde cevap verir. Yayından önce misafirleriniz için en önemli dilleri test ederiz.'],
    ['Does it integrate with WhatsApp?', 'WhatsApp ile çalışır mı?', 'Yes, through the official WhatsApp Business Platform from Meta. You need a WhatsApp Business account and a number for it; we guide you through the setup. Meta charges its own messaging fees, which we show separately in the proposal.', 'Evet, Meta\'nın resmi WhatsApp Business Platform\'u üzerinden. Bir WhatsApp Business hesabı ve buna ayrılmış bir numara gerekir; kurulumda size eşlik ederiz. Meta kendi mesaj ücretlerini alır, bunları teklifte ayrıca gösteririz.'],
    ['Can it connect to our existing reservation system?', 'Mevcut rezervasyon sistemimize bağlanabilir mi?', 'It depends on the system. Many property management systems and booking engines offer an API or an email-based connection. We check yours during the workflow analysis and tell you plainly what can be connected. Without an integration, inquiries reach your team by email or another channel you choose.', 'Sisteme göre değişir. Birçok otel yönetim sistemi ve rezervasyon motoru API veya e-posta tabanlı bağlantı sunar. İş akışı analizinde sizinkini inceler, neyin bağlanabileceğini açıkça söyleriz. Entegrasyon yoksa talepler ekibinize e-postayla veya seçtiğiniz başka bir kanaldan ulaşır.'],
    ['Does it replace hotel employees?', 'Otel çalışanlarının yerini alır mı?', 'No. It takes over repetitive questions and collects inquiry details so your team can focus on confirming bookings and looking after guests. Your staff stay in control and can take over any conversation.', 'Hayır. Tekrarlanan soruları üstlenir ve talep bilgilerini toplar; böylece ekibiniz rezervasyonu onaylamaya ve misafirle ilgilenmeye odaklanır. Kontrol ekibinizde kalır, istedikleri konuşmayı devralabilirler.'],
    ['How long does implementation take?', 'Kurulum ne kadar sürer?', 'It depends on the channels and integrations you choose. After the workflow analysis you receive a written plan with dates. A website assistant is usually the quickest place to start.', 'Seçtiğiniz kanallara ve entegrasyonlara bağlıdır. İş akışı analizinden sonra tarihli, yazılı bir plan alırsınız. Web sitesi asistanı genellikle en hızlı başlangıçtır.'],
    ['What happens when the AI cannot answer?', 'Yapay zekâ cevap veremezse ne olur?', 'It says so instead of guessing. It records the guest\'s question and contact details and hands the conversation to your team, who reply directly.', 'Tahmin yürütmek yerine bunu açıkça söyler. Misafirin sorusunu ve iletişim bilgisini kaydeder, konuşmayı ekibinize devreder; ekibiniz doğrudan cevap verir.'],
    ['Is customer data secure?', 'Misafir verileri güvende mi?', 'Data is sent over encrypted connections, access is limited to your team and ours for support, and it is kept only as long as needed. Before launch we document together how guest data is handled, taking GDPR and KVKK into account.', 'Veriler şifreli bağlantılarla iletilir, erişim yalnızca sizin ekibinizle ve destek için bizim ekibimizle sınırlıdır ve yalnızca gerektiği süre saklanır. Yayından önce misafir verisinin nasıl işleneceğini KVKK ve GDPR\'ı dikkate alarak birlikte yazılı hale getiririz.'],
    ['How much does AXON cost?', 'AXON ne kadar?', 'Start begins at $300 per month. Pro and Enterprise are quoted after a short analysis. The one-time setup fee and usage-based costs, such as WhatsApp messaging fees charged by Meta, are listed separately in every proposal.', 'Start paketi aylık $300\'dan başlar. Pro ve Kurumsal kısa bir analizden sonra teklif edilir. Tek seferlik kurulum bedeli ve Meta\'nın WhatsApp mesaj ücretleri gibi kullanıma bağlı maliyetler her teklifte ayrıca yazılır.']
  ];
  function renderFaq() {
    $('#faqList').innerHTML = FAQ.map(function (q) {
      return '<details class="group px-6 py-5"><summary class="flex cursor-pointer list-none items-start justify-between gap-6 font-display text-[16px] font-semibold text-ink"><span>' + esc(L(q[0], q[1])) + '</span><span class="mt-0.5 text-gold transition group-open:rotate-45" aria-hidden="true">+</span></summary>' +
        '<p class="mt-3 text-[15px] leading-relaxed">' + esc(L(q[2], q[3])) + '</p></details>';
    }).join('');
  }
  listeners.push(renderFaq);

  /* ================= 01 Hero illustration ================= */
  var HERO = [
    ['g', 'Hello, do you have a double room available for December 15–18?', 'Merhaba, 15–18 Aralık için çift kişilik odanız var mı?'],
    ['a', 'Welcome! I\'d be happy to help. How many guests will be staying?', 'Hoş geldiniz! Memnuniyetle yardımcı olurum. Kaç kişi konaklayacaksınız?'],
    ['g', 'Two adults.', 'İki yetişkin.'],
    ['a', 'Wonderful. Your inquiry for Dec 15–18, 2 adults is ready. Our team will confirm the rate.', 'Harika. 15–18 Aralık, 2 yetişkin için talebiniz hazır. Ekibimiz fiyatı onaylayacak.']
  ];
  var heroTimer = [];
  function bubble(who, text, anim) {
    var g = who === 'g';
    return '<div class="flex ' + (g ? 'justify-end' : 'justify-start') + (anim ? ' bubble-in' : '') + '"><p class="max-w-[85%] rounded-2xl px-4 py-2.5 ' + (g ? 'rounded-br-md bg-silver/90 text-navy-950' : 'rounded-bl-md border border-white/[0.07] bg-navy-800 text-ink') + '">' + esc(text) + '</p></div>';
  }
  function heroState(step) {
    $('#hsLang').textContent = step >= 1 ? L('English · auto', 'Türkçe · otomatik') : '–';
    $('#hsReq').textContent = step >= 3 ? L('Dec 15–18 · 2 ad.', '15–18 Ara · 2 yet.') : step >= 1 ? L('Dec 15–18', '15–18 Ara') : '–';
    $('#hsLead').textContent = step >= 4 ? L('Captured', 'Alındı') : step >= 1 ? L('Qualifying', 'Toplanıyor') : '–';
    $('#hsLead').className = 'mt-0.5 font-semibold ' + (step >= 4 ? 'text-gold' : 'text-ink');
    var t = $('#hsToast'); t.classList.toggle('opacity-0', step < 4); t.classList.toggle('translate-y-2', step < 4);
  }
  var heroVisible = true;
  function runHero() {
    heroTimer.forEach(clearTimeout); heroTimer = [];
    var box = $('#heroChat');
    if (reduce) { box.innerHTML = HERO.map(function (m) { return bubble(m[0], L(m[1], m[2])); }).join(''); heroState(4); return; }
    box.innerHTML = ''; heroState(0);
    var t = 500;
    HERO.forEach(function (m, i) {
      if (m[0] === 'a') {
        heroTimer.push(setTimeout(function () { box.insertAdjacentHTML('beforeend', '<div class="typing flex gap-1 px-1 py-2" id="hTyping"><i></i><i></i><i></i></div>'); }, t));
        t += 1100;
      }
      heroTimer.push(setTimeout(function () { var ty = $('#hTyping'); if (ty) ty.remove(); box.insertAdjacentHTML('beforeend', bubble(m[0], L(m[1], m[2]), true)); heroState(i + 1); }, t));
      t += m[0] === 'g' ? 900 : 1500;
    });
    // replay only while the hero is on screen
    heroTimer.push(setTimeout(function () { if (heroVisible) runHero(); else heroPending = true; }, t + 7000));
  }
  var heroPending = false;
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { heroVisible = es[0].isIntersecting; if (heroVisible && heroPending) { heroPending = false; runHero(); } }).observe($('#heroChat'));
  listeners.push(runHero);

  /* ================= 05 Live demo: assistant ================= */
  // Simulation with predefined responses. If /api/chat is configured on the server, it switches to live AI.
  var R = {
    greet: { en: 'Welcome to Aurelia Boutique Hotel! How can I help you today? I can answer questions about the hotel or help you send a reservation inquiry.', tr: 'Aurelia Boutique Hotel\'e hoş geldiniz! Size nasıl yardımcı olabilirim? Otel hakkındaki sorularınızı cevaplayabilir ya da rezervasyon talebinizi iletebilirim.', de: 'Willkommen im Aurelia Boutique Hotel! Wie kann ich Ihnen helfen? Ich beantworte Fragen zum Hotel oder leite Ihre Reservierungsanfrage weiter.', es: '¡Bienvenido al Aurelia Boutique Hotel! ¿En qué puedo ayudarle? Puedo responder sus preguntas o enviar su solicitud de reserva.', fr: 'Bienvenue à l\'Aurelia Boutique Hotel ! Comment puis-je vous aider ? Je réponds à vos questions ou transmets votre demande de réservation.' },
    askGuests: { en: 'Welcome! I\'d be happy to help. How many guests will be staying?', tr: 'Hoş geldiniz! Memnuniyetle yardımcı olurum. Kaç kişi konaklayacaksınız?', de: 'Willkommen! Sehr gern. Für wie viele Gäste darf ich anfragen?', es: '¡Bienvenido! Con mucho gusto. ¿Cuántas personas se alojarán?', fr: 'Bienvenue ! Avec plaisir. Combien de personnes séjourneront ?' },
    askDates: { en: 'With pleasure. For which dates would you like to stay?', tr: 'Memnuniyetle. Hangi tarihlerde konaklamak istersiniz?', de: 'Sehr gern. Für welche Daten möchten Sie anfragen?', es: 'Con mucho gusto. ¿Para qué fechas desea alojarse?', fr: 'Avec plaisir. Pour quelles dates souhaitez-vous séjourner ?' },
    askRoom: { en: 'Wonderful. Which room would you prefer: Classic Double (22 m²), Deluxe Double with city view (28 m²) or Junior Suite (38 m², up to 3 guests)?', tr: 'Harika. Hangi odayı tercih edersiniz: Classic Double (22 m²), şehir manzaralı Deluxe Double (28 m²) veya Junior Suite (38 m², 3 kişiye kadar)?', de: 'Wunderbar. Welches Zimmer bevorzugen Sie: Classic Double (22 m²), Deluxe Double mit Stadtblick (28 m²) oder Junior Suite (38 m², bis 3 Gäste)?', es: 'Perfecto. ¿Qué habitación prefiere: Classic Double (22 m²), Deluxe Double con vista a la ciudad (28 m²) o Junior Suite (38 m², hasta 3 personas)?', fr: 'Parfait. Quelle chambre préférez-vous : Classic Double (22 m²), Deluxe Double vue ville (28 m²) ou Junior Suite (38 m², jusqu\'à 3 personnes) ?' },
    askContact: { en: 'Wonderful. I can help you submit a reservation inquiry. May I have your name and email, so our reservations team can confirm availability and the rate?', tr: 'Harika. Rezervasyon talebinizi iletebilirim. Rezervasyon ekibimizin müsaitliği ve fiyatı onaylayabilmesi için adınızı ve e-posta adresinizi alabilir miyim?', de: 'Wunderbar. Ich kann Ihre Reservierungsanfrage weiterleiten. Darf ich Ihren Namen und Ihre E-Mail-Adresse haben, damit unser Team Verfügbarkeit und Preis bestätigt?', es: 'Perfecto. Puedo enviar su solicitud de reserva. ¿Me indica su nombre y correo electrónico para que nuestro equipo confirme disponibilidad y tarifa?', fr: 'Parfait. Je peux transmettre votre demande. Puis-je avoir votre nom et votre e-mail afin que notre équipe confirme la disponibilité et le tarif ?' },
    askEmail: { en: 'Thank you. Which email address should our team use to reply?', tr: 'Teşekkürler. Ekibimiz hangi e-posta adresinden size dönsün?', de: 'Danke. An welche E-Mail-Adresse darf unser Team antworten?', es: 'Gracias. ¿A qué correo electrónico debe responder nuestro equipo?', fr: 'Merci. À quelle adresse e-mail notre équipe doit-elle répondre ?' },
    askName: { en: 'Thank you. And under which name should we register the inquiry?', tr: 'Teşekkürler. Talebi hangi isimle kaydedelim?', de: 'Danke. Auf welchen Namen dürfen wir die Anfrage notieren?', es: 'Gracias. ¿A nombre de quién registramos la solicitud?', fr: 'Merci. À quel nom enregistrons-nous la demande ?' },
    done: { en: 'Thank you, {name}. Your inquiry for {room}, {dates}, {guests} is ready for our reservations team. They will email you at {email} to confirm availability and the rate.', tr: 'Teşekkürler {name}. {room}, {dates}, {guests} için talebiniz rezervasyon ekibimize hazır. Müsaitliği ve fiyatı onaylamak için {email} adresine yazacaklar.', de: 'Danke, {name}. Ihre Anfrage für {room}, {dates}, {guests} liegt unserem Reservierungsteam vor. Es meldet sich unter {email} mit Verfügbarkeit und Preis.', es: 'Gracias, {name}. Su solicitud para {room}, {dates}, {guests} está lista para nuestro equipo de reservas. Le escribirán a {email} para confirmar disponibilidad y tarifa.', fr: 'Merci, {name}. Votre demande pour {room}, {dates}, {guests} est prête pour notre équipe de réservation. Elle vous écrira à {email} pour confirmer disponibilité et tarif.' },
    checkin: { en: 'Check-in is from 14:00 and check-out is until 12:00. Early check-in or late check-out can be requested and depends on availability.', tr: 'Giriş 14:00\'ten itibaren, çıkış 12:00\'ye kadardır. Erken giriş veya geç çıkış talep edilebilir, müsaitliğe bağlıdır.', de: 'Check-in ab 14:00 Uhr, Check-out bis 12:00 Uhr. Früher Check-in oder später Check-out ist auf Anfrage möglich, je nach Verfügbarkeit.', es: 'El check-in es a partir de las 14:00 y el check-out hasta las 12:00. Se puede solicitar entrada anticipada o salida tardía según disponibilidad.', fr: 'L\'arrivée se fait à partir de 14h00 et le départ jusqu\'à 12h00. Une arrivée anticipée ou un départ tardif est possible selon disponibilité.' },
    breakfast: { en: 'Breakfast is served from 07:00 to 10:30 and is included in our flexible rates. For other rates it can be added when you book.', tr: 'Kahvaltı 07:00–10:30 arası servis edilir ve esnek fiyatlarımıza dahildir. Diğer fiyatlarda rezervasyon sırasında eklenebilir.', de: 'Frühstück gibt es von 07:00 bis 10:30 Uhr; in flexiblen Raten ist es inklusive, sonst bei der Buchung zubuchbar.', es: 'El desayuno se sirve de 07:00 a 10:30 y está incluido en las tarifas flexibles. En otras tarifas puede añadirse al reservar.', fr: 'Le petit-déjeuner est servi de 7h00 à 10h30 et inclus dans les tarifs flexibles. Sinon, il peut être ajouté à la réservation.' },
    parking: { en: 'We have limited on-site parking, available on request. I can add a parking request to your inquiry.', tr: 'Otelde sınırlı sayıda otopark yerimiz var, talep üzerine ayrılır. Talebinize otopark notu ekleyebilirim.', de: 'Wir haben eine begrenzte Zahl an Parkplätzen auf Anfrage. Ich kann den Wunsch Ihrer Anfrage hinzufügen.', es: 'Disponemos de aparcamiento limitado bajo petición. Puedo añadirlo a su solicitud.', fr: 'Nous disposons d\'un parking limité sur demande. Je peux l\'ajouter à votre demande.' },
    transfer: { en: 'Yes, we can arrange an airport transfer on request. Our team will confirm the details and price with your inquiry.', tr: 'Evet, talep üzerine havalimanı transferi ayarlayabiliriz. Ekibimiz detayları ve ücreti talebinizle birlikte onaylar.', de: 'Ja, ein Flughafentransfer ist auf Anfrage möglich. Unser Team bestätigt Details und Preis mit Ihrer Anfrage.', es: 'Sí, podemos organizar el traslado al aeropuerto bajo petición. Nuestro equipo confirmará detalles y precio.', fr: 'Oui, un transfert aéroport peut être organisé sur demande. Notre équipe confirmera les détails et le prix.' },
    price: { en: 'Rates depend on dates and room type, so I can\'t quote a fixed price here. Share your dates and number of guests and our team will send the exact rate.', tr: 'Fiyatlar tarihe ve oda tipine göre değişir, bu yüzden burada sabit bir fiyat veremem. Tarihlerinizi ve kişi sayısını paylaşırsanız ekibimiz net fiyatı gönderir.', de: 'Die Preise hängen von Datum und Zimmertyp ab, daher nenne ich hier keinen festen Preis. Nennen Sie Daten und Personenzahl, dann schickt unser Team den genauen Preis.', es: 'Las tarifas dependen de las fechas y del tipo de habitación, así que no puedo dar un precio fijo aquí. Indíqueme fechas y número de personas y nuestro equipo le enviará la tarifa exacta.', fr: 'Les tarifs dépendent des dates et de la chambre, je ne peux donc pas donner de prix fixe ici. Indiquez vos dates et le nombre de personnes, notre équipe vous enverra le tarif exact.' },
    rooms: { en: 'We have three room types: Classic Double (22 m², up to 2 guests), Deluxe Double with city view (28 m², up to 2 guests) and Junior Suite (38 m², up to 3 guests).', tr: 'Üç oda tipimiz var: Classic Double (22 m², 2 kişi), şehir manzaralı Deluxe Double (28 m², 2 kişi) ve Junior Suite (38 m², 3 kişiye kadar).', de: 'Wir haben drei Zimmertypen: Classic Double (22 m², 2 Gäste), Deluxe Double mit Stadtblick (28 m², 2 Gäste) und Junior Suite (38 m², bis 3 Gäste).', es: 'Tenemos tres tipos: Classic Double (22 m², 2 personas), Deluxe Double con vista a la ciudad (28 m², 2 personas) y Junior Suite (38 m², hasta 3).', fr: 'Nous avons trois types de chambres : Classic Double (22 m², 2 personnes), Deluxe Double vue ville (28 m², 2 personnes) et Junior Suite (38 m², jusqu\'à 3).' },
    human: { en: 'Of course. I\'m handing this conversation to our front desk team with everything you\'ve written so far. A colleague will reply here shortly.', tr: 'Elbette. Bu konuşmayı şimdiye kadar yazdıklarınızla birlikte resepsiyon ekibimize devrediyorum. Bir arkadaşımız kısa süre içinde buradan cevap verecek.', de: 'Natürlich. Ich übergebe das Gespräch mit allen bisherigen Angaben an unsere Rezeption. Ein Kollege antwortet Ihnen gleich hier.', es: 'Por supuesto. Paso esta conversación a nuestra recepción con todo lo que ha escrito. Un compañero le responderá aquí en breve.', fr: 'Bien sûr. Je transmets cette conversation à notre réception avec tout ce que vous avez écrit. Un collègue vous répondra ici rapidement.' },
    fallback: { en: 'Good question. I don\'t have that information in this demo, so I\'ll pass it to our team. Meanwhile, can I help with dates, rooms, breakfast, parking or check-in times?', tr: 'Güzel soru. Bu bilgi demoda yok, bu yüzden ekibimize iletiyorum. Bu arada tarih, oda, kahvaltı, otopark veya giriş saatleri konusunda yardımcı olabilirim.', de: 'Gute Frage. Diese Information habe ich in der Demo nicht, ich gebe sie an unser Team weiter. Kann ich bei Daten, Zimmern, Frühstück, Parken oder Check-in helfen?', es: 'Buena pregunta. No tengo esa información en esta demo, así que la paso a nuestro equipo. ¿Le ayudo con fechas, habitaciones, desayuno, aparcamiento o check-in?', fr: 'Bonne question. Je n\'ai pas cette information dans la démo, je la transmets à notre équipe. Puis-je vous aider pour les dates, chambres, petit-déjeuner, parking ou horaires ?' }
  };
  var LANG_NAME = { en: 'English', tr: 'Türkçe', de: 'Deutsch', es: 'Español', fr: 'Français' };
  var MONTHS = { jan: 1, january: 1, ocak: 1, januar: 1, enero: 1, janvier: 1, feb: 2, february: 2, şubat: 2, subat: 2, februar: 2, febrero: 2, février: 2, fevrier: 2, mar: 3, march: 3, mart: 3, märz: 3, marz: 3, marzo: 3, mars: 3, apr: 4, april: 4, nisan: 4, abril: 4, avril: 4, may: 5, mayıs: 5, mayis: 5, mai: 5, mayo: 5, jun: 6, june: 6, haziran: 6, juni: 6, junio: 6, juin: 6, jul: 7, july: 7, temmuz: 7, juli: 7, julio: 7, juillet: 7, aug: 8, august: 8, ağustos: 8, agustos: 8, agosto: 8, août: 8, aout: 8, sep: 9, sept: 9, september: 9, eylül: 9, eylul: 9, septiembre: 9, septembre: 9, oct: 10, october: 10, ekim: 10, oktober: 10, octubre: 10, octobre: 10, nov: 11, november: 11, kasım: 11, kasim: 11, noviembre: 11, novembre: 11, dec: 12, december: 12, aralık: 12, aralik: 12, dezember: 12, diciembre: 12, décembre: 12, decembre: 12 };
  var MSHORT = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], tr: ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'] };
  var NUMW = { one: 1, two: 2, three: 3, four: 4, five: 5, bir: 1, iki: 2, 'üç': 3, uc: 3, 'dört': 4, dort: 4, 'beş': 5, eins: 1, ein: 1, zwei: 2, drei: 3, vier: 4, uno: 1, dos: 2, tres: 3, cuatro: 4, un: 1, deux: 2, trois: 3, quatre: 4 };
  var GUEST_W = '(adults?|guests?|people|persons?|kişi|kisi|yetişkin|yetiskin|erwachsene|personen|gäste|adultos|personas|adultes|personnes)';
  var ROOMNAMES = /\b(classic|deluxe|double|junior|suite|room|oda)\b/i;

  var chat;
  function low(t) { return String(t).replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase(); }
  function detectLang(t) {
    var s = low(t);
    if (/[ğışç]|\b(merhaba|selam|oda|müsait|musait|kahvaltı|kahvalti|otopark|kişi|kisi|teşekkür|tesekkur|giriş|nasıl|var mı|istiyorum|aralık|yetişkin|iki)\b/.test(s)) return 'tr';
    if (/[äöß]|\b(hallo|guten|zimmer|frühstück|fruhstuck|parkplatz|bitte|danke|ich|habt|haben|personen|erwachsene)\b/.test(s)) return 'de';
    if (/[¿¡ñ]|\b(hola|habitación|habitacion|desayuno|gracias|tienen|personas|adultos|quiero|aparcamiento)\b/.test(s)) return 'es';
    if (/\b(bonjour|chambre|petit-déjeuner|merci|avez-vous|personnes|adultes|je voudrais|bonsoir)\b/.test(s)) return 'fr';
    if (/\b(hello|hi|hey|room|available|breakfast|parking|guests|adults|thanks|please|do you|would like|check|speak|person)\b/.test(s)) return 'en';
    return null;
  }
  function fmtDates(d) { var ml = lang === 'tr' ? 'tr' : 'en', m = MSHORT[ml][d.m - 1]; return ml === 'tr' ? d.a + '–' + d.b + ' ' + m : m + ' ' + d.a + '–' + d.b; }
  function parseDates(t) {
    var s = low(t), m, mon = '([a-zçğıöşüäéû]+)';
    if ((m = s.match(new RegExp('(\\d{1,2})\\.?\\s*(?:-|–|to|bis|al|au|ile)\\s*(\\d{1,2})\\.?\\s*(?:de\\s+)?' + mon)))) { var mm = MONTHS[m[3]] || MONTHS[m[3].slice(0, 3)]; if (mm) return { a: +m[1], b: +m[2], m: mm }; }
    if ((m = s.match(new RegExp(mon + '\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to)\\s*(\\d{1,2})')))) { var m2 = MONTHS[m[1]] || MONTHS[m[1].slice(0, 3)]; if (m2) return { a: +m[2], b: +m[3], m: m2 }; }
    if ((m = s.match(/(\d{1,2})[./](\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})[./](\d{1,2})/))) return { a: +m[1], b: +m[3], m: +m[2] };
    return null;
  }
  function parseGuests(t) {
    var s = low(t), m = s.match(new RegExp('(\\d)\\s*' + GUEST_W));
    if (m) return +m[1];
    var w = s.match(new RegExp('([a-zçğıöşü]+)\\s+' + GUEST_W));
    if (w && NUMW[w[1]]) return NUMW[w[1]];
    if (chat.expect === 'askGuests') { var d = s.match(/^\s*(\d)\s*\.?\s*$/); if (d) return +d[1]; var only = s.trim().replace(/[.!]/g, ''); if (NUMW[only]) return NUMW[only]; }
    return null;
  }
  function parseRoom(t) {
    var s = low(t);
    if (/suite|süit/.test(s)) return 'Junior Suite';
    if (/deluxe|city view|manzara|stadtblick|vista/.test(s)) return 'Deluxe Double';
    if (/classic|klasik|standard|standart/.test(s)) return 'Classic Double';
    if (/double|çift|cift|doppel|doble|twin|king|queen/.test(s)) return 'Double';
    return null;
  }
  function parseContact(t) {
    var em = t.match(/[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/i), out = {};
    if (em) out.email = em[0];
    if (!em && chat.expect !== 'askContact' && chat.expect !== 'askName') return out;
    var rest = t.replace(em ? em[0] : '', ' ').replace(/\b(my name is|i am|i'm|name is|adım|benim adım|ismim|ich heiße|ich bin|me llamo|soy|je m'appelle|je suis|and|ve|und|et|email|e-posta|mail)\b/gi, ' ').replace(/[,:;.!]/g, ' ').trim();
    var words = rest.split(/\s+/).filter(function (w) { return /^[A-ZÇĞİÖŞÜÄÉ][a-zçğıöşüäéèß'-]+$/.test(w) && !ROOMNAMES.test(w); });
    if (words.length) out.name = words.slice(0, 3).join(' ');
    return out;
  }
  function say(key, vars) {
    var s = R[key][chat.lang] || R[key].en;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }
  function guestsText(n) {
    var w = { en: [' adult', ' adults'], tr: [' yetişkin', ' yetişkin'], de: [' Erwachsener', ' Erwachsene'], es: [' adulto', ' adultos'], fr: [' adulte', ' adultes'] }[chat.lang] || [' adult', ' adults'];
    return n + (n > 1 ? w[1] : w[0]);
  }
  function ask(key) { chat.expect = key; return say(key); }
  function nextStep() {
    if (!chat.dates) return ask('askDates');
    if (!chat.guests) return ask('askGuests');
    if (!chat.room || (chat.room === 'Double' && chat.guests > 2)) return ask('askRoom');
    if (!chat.name && !chat.email) return ask('askContact');
    if (!chat.email) return ask('askEmail');
    if (!chat.name) return ask('askName');
    chat.done = true; chat.expect = null;
    var room = chat.room === 'Double' ? ({ en: 'a double room', tr: 'çift kişilik oda', de: 'ein Doppelzimmer', es: 'una habitación doble', fr: 'une chambre double' }[chat.lang]) : chat.room;
    return say('done', { name: chat.name, room: room, dates: fmtDates(chat.dates), guests: guestsText(chat.guests), email: chat.email });
  }
  function simulate(text) {
    var s = low(text);
    var d = parseDates(text), g = parseGuests(text), r = parseRoom(text), c = parseContact(text);
    if (d) chat.dates = d; if (g) chat.guests = g; if (r) chat.room = r; if (c.email) chat.email = c.email; if (c.name) chat.name = c.name;
    var booking = /\b(book|reserve|reservation|available|availability|stay|rezervasyon|müsait|musait|yer var|oda|zimmer|frei|reservier\w*|reserva\w*|disponible|habitación|habitacion|chambre|réserv\w*)\b/.test(s);
    if (d || g || booking || c.email || (r && chat.flow)) chat.flow = true;
    if (/\b(human|person|someone|staff|agent|insan|yetkili|biriyle|temsilci|mitarbeiter|persona|humain|quelqu'un)\b/.test(s)) return say('human');
    if (/check.?in|check.?out|giriş|çıkış|anreise|abreise|entrada|salida|arrivée|départ|kaçta/.test(s)) return say('checkin');
    if (/breakfast|kahvaltı|kahvalti|frühstück|fruhstuck|desayuno|petit/.test(s)) return say('breakfast');
    if (/parking|otopark|parkplatz|aparcamiento/.test(s)) return say('parking');
    if (/airport|transfer|havaliman|flughafen|aeropuerto|aéroport/.test(s)) return say('transfer');
    if (chat.done) return say('fallback');
    if (!d && !g && !c.email && /\b(price|rate|cost|how much|fiyat|ücret|ne kadar|preis|kostet|precio|cuánto|prix|combien)\b/.test(s)) return say('price');
    if (!chat.flow && /\b(rooms|room types|odalar|oda tipleri|zimmer|habitaciones|chambres)\b/.test(s)) return say('rooms');
    if (chat.flow) return nextStep();
    if (/^(hi|hello|hey|merhaba|selam|hallo|guten tag|hola|bonjour|bonsoir)\b/.test(s.trim())) return say('greet');
    return say('fallback');
  }
  function addMsg(who, text) {
    var log = $('#chatLog');
    log.insertAdjacentHTML('beforeend', bubble(who === 'user' ? 'g' : 'a', text, true));
    log.scrollTop = log.scrollHeight;
  }
  function renderLead() {
    var rows = [[L('Language', 'Dil'), chat.langSeen ? LANG_NAME[chat.lang] : '–'], [L('Dates', 'Tarihler'), chat.dates ? fmtDates(chat.dates) : '–'], [L('Guests', 'Kişi'), chat.guests ? guestsText(chat.guests) : '–'],
      [L('Room', 'Oda'), chat.room || '–'], [L('Name', 'Ad'), chat.name || '–'], [L('Email', 'E-posta'), chat.email || '–']];
    $('#leadPanel').innerHTML = rows.map(function (r) { return '<div class="flex justify-between gap-4 border-b border-white/[0.05] pb-2.5"><dt class="text-mist">' + r[0] + '</dt><dd class="min-w-0 break-all text-right font-medium ' + (r[1] === '–' ? 'text-mist/50' : 'text-ink') + '">' + esc(r[1]) + '</dd></div>'; }).join('');
    var st = $('#leadStatus');
    st.textContent = chat.done ? L('Lead captured', 'Talep alındı') : L('Collecting', 'Toplanıyor');
    st.className = 'tag ' + (chat.done ? 'border-gold/50 text-gold' : 'border-white/10 text-mist');
  }
  var mode = 'sim';
  function setMode(m) {
    mode = m; var el = $('#demoMode');
    el.textContent = m === 'ai' ? L('Live AI · demo hotel', 'Canlı yapay zekâ · demo otel') : L('Simulated demo', 'Simülasyon');
    el.className = 'tag ' + (m === 'ai' ? 'border-emerald-400/30 text-emerald-300' : 'border-amber-300/30 text-amber-200');
    $('#demoNote').textContent = m === 'ai'
      ? L('Live AI mode: replies are generated by an AI model for a fictional hotel. It is not connected to any reservation system, and inquiries are not sent anywhere.', 'Canlı yapay zekâ modu: cevaplar kurgusal bir otel için yapay zekâ modeli tarafından üretilir. Hiçbir rezervasyon sistemine bağlı değildir ve talepler bir yere gönderilmez.')
      : L('This demo is a simulation with predefined responses. It uses a fictional hotel, is not connected to any real reservation system, and nothing you type is sent anywhere.', 'Bu demo önceden tanımlanmış cevaplarla çalışan bir simülasyondur. Kurgusal bir otel kullanır, gerçek bir rezervasyon sistemine bağlı değildir ve yazdığınız hiçbir bilgi bir yere gönderilmez.');
  }
  var aiState = 'unknown';  // unknown → ai | off
  function tryAI(text) {
    if (aiState === 'off') return Promise.resolve(null);
    var ctl = 'AbortController' in window ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, 9000);
    return fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, history: chat.history.slice(-11, -1) }), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(to); if (r.status === 503 || r.status === 404 || r.status === 405) aiState = 'off'; return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.reply) { aiState = 'ai'; setMode('ai'); return j.reply; } return null; })
      .catch(function () { clearTimeout(to); if (aiState === 'unknown') aiState = 'off'; return null; });
  }
  var busy = false, touched = false, chatGen = 0;
  function send(text) {
    text = String(text || '').trim().slice(0, 400); if (!text || busy) return;
    if (!touched) { touched = true; track('live_demo_interaction', { first_action: 'message' }); }
    var dl = detectLang(text); if (dl) { chat.lang = dl; chat.langSeen = true; }
    addMsg('user', text); chat.history.push({ role: 'user', content: text });
    var wasDone = chat.done, simReply = simulate(text);
    renderLead();
    busy = true;
    var gen = chatGen;
    var log = $('#chatLog'); log.insertAdjacentHTML('beforeend', '<div class="typing flex gap-1 px-1 py-2" id="cTyping"><i></i><i></i><i></i></div>'); log.scrollTop = log.scrollHeight;
    tryAI(text).then(function (ai) {
      if (gen !== chatGen) return; // chat was reset while the reply was on its way
      setTimeout(function () {
        if (gen !== chatGen) return;
        // 2. keep the badge honest: a failed AI call falls back to the simulation
        if (!ai && mode === 'ai') setMode('sim');
        var ty = $('#cTyping'); if (ty) ty.remove();
        var reply = ai || simReply;
        addMsg('bot', reply); chat.history.push({ role: 'assistant', content: reply });
        if (chat.done && !wasDone) {
          log.insertAdjacentHTML('beforeend', '<div class="bubble-in rounded-xl border border-gold/30 bg-gold/[0.06] p-4 text-[13.5px] text-ink"><p class="font-semibold text-gold">' + esc(L('Lead captured', 'Talep alındı')) + '</p><p class="mt-1 text-mist">' + esc(L('Demo only: nothing was sent. In your hotel, this inquiry would go straight to your team.', 'Yalnızca demo: hiçbir şey gönderilmedi. Sizin otelinizde bu talep doğrudan ekibinize gider.')) + '</p><a href="#contact" data-cta="demo" data-cta-loc="demo_chat" class="mt-3 inline-flex font-semibold text-gold hover:text-gold-soft">' + esc(L('Want this for your hotel? Book a demo →', 'Bunu otelinize mi istiyorsunuz? Demo alın →')) + '</a></div>');
          log.scrollTop = log.scrollHeight;
        }
        busy = false;
      }, ai ? 120 : 650);
    });
  }
  var CHIPS = [
    ['Do you have a double room for December 15–18?', '15–18 Aralık için çift kişilik oda var mı?'],
    ['Two adults.', 'İki yetişkin.'],
    ['What time is check-in?', 'Giriş saati kaçta?'],
    ['Is breakfast included?', 'Kahvaltı dahil mi?'],
    ['Hallo, habt ihr ein Zimmer frei?', 'Hallo, habt ihr ein Zimmer frei?'],
    ['Hola, ¿tienen parking?', 'Hola, ¿tienen parking?'],
    ['Can I speak to a person?', 'Biriyle görüşebilir miyim?']
  ];
  function renderChips() {
    $('#chips').innerHTML = CHIPS.map(function (c) { var t = L(c[0], c[1]); return '<button type="button" class="chip-b flex-none rounded-full border border-white/10 bg-navy-800 px-3.5 py-2 text-[13px] text-ink transition hover:border-gold/40" data-t="' + esc(t) + '">' + esc(t) + '</button>'; }).join('');
  }
  $('#chips').addEventListener('click', function (e) { var b = e.target.closest('.chip-b'); if (b) send(b.getAttribute('data-t')); });
  $('#chatForm').addEventListener('submit', function (e) { e.preventDefault(); var i = $('#chatInput'); send(i.value); i.value = ''; });
  function resetChat() {
    chatGen++;
    chat = { lang: lang === 'tr' ? 'tr' : 'en', langSeen: false, dates: null, guests: null, room: null, name: null, email: null, flow: false, done: false, expect: null, history: [] };
    busy = false;
    $('#chatLog').innerHTML = ''; addMsg('bot', say('greet')); renderLead();
  }
  $('#chatReset').addEventListener('click', resetChat);
  listeners.push(function () { renderChips(); setMode(mode); if (!chat || chat.history.length === 0) resetChat(); else renderLead(); });

  /* ================= 07 Booking engine (demo inventory) ================= */
  var E = function (k, vars) { var s = ENGINE[lang][k]; if (vars && typeof s === 'string') Object.keys(vars).forEach(function (v) { s = s.replace('{' + v + '}', vars[v]); }); return s; };
  var LOC = { en: 'en-GB', tr: 'tr-TR' };
  var ROOMS = [{ size: 32, maxAdults: 2, base: 92 }, { size: 30, maxAdults: 2, base: 96 }, { size: 42, maxAdults: 3, base: 158 }, { size: 48, maxAdults: 5, base: 178 }];
  function roomT(i) { var r = E('rooms')[i]; return { name: r[0], beds: r[1], desc: r[2] }; }
  var FX = { EUR: { rate: 1, sym: '€' }, USD: { rate: 1.09, sym: '$' }, TRY: { rate: 44.5, sym: '₺' } };
  var st = { room: 0, cur: 'EUR', inD: null, outD: null, adults: 2 };
  var today = new Date(); today.setHours(0, 0, 0, 0);
  function hash(n) { var x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }
  function dayKey(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  function nightly(d, ri) { var f = 1 + (hash(dayKey(d)) - .5) * .16, dow = d.getDay(), m = d.getMonth(); if (dow === 5 || dow === 6) f *= 1.18; if (m >= 3 && m <= 9) f *= 1.08; return Math.round(ROOMS[ri].base * f); }
  function soldOut(d, ri) { return hash(dayKey(d) * 7 + ri * 131) < .07; }
  function fmt(eur) { return FX[st.cur].sym + ' ' + Math.round(eur * FX[st.cur].rate).toLocaleString(LOC[lang]); }
  function short(eur) { var v = eur * FX[st.cur].rate; return st.cur === 'TRY' ? (v >= 10000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v / 10) * 10 + '') : FX[st.cur].sym + Math.round(v); }
  function same(a, b) { return a && b && a.getTime() === b.getTime(); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function nightsBetween(a, b) { return Math.round((b - a) / 864e5); }
  function rangeSold(a, b, ri) { for (var d = new Date(a); d < b; d = addDays(d, 1)) if (soldOut(d, ri)) return true; return false; }
  (function pick() { for (var s = 7; s < 50; s++) { var a = addDays(today, s), b = addDays(a, 3); if (!rangeSold(a, b, st.room)) { st.inD = a; st.outD = b; return; } } })();
  var tabs = $('#roomTabs');
  ROOMS.forEach(function (r, i) {
    var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(i === 0));
    b.className = 'rounded-lg px-3 py-2 text-[13px] font-medium text-mist transition hover:text-ink aria-selected:bg-white/10 aria-selected:text-ink';
    b.addEventListener('click', function () { st.room = i; st.adults = Math.min(st.adults, r.maxAdults); if (st.inD && st.outD && rangeSold(st.inD, st.outD, i)) { st.inD = st.outD = null; } $$('[role=tab]', tabs).forEach(function (t, j) { t.setAttribute('aria-selected', String(j === i)); }); renderEngine(); });
    tabs.appendChild(b);
  });
  $$('#currencySeg button').forEach(function (b) { b.addEventListener('click', function () { st.cur = b.dataset.cur; $$('#currencySeg button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); renderEngine(); }); });
  $('#adMinus').addEventListener('click', function () { if (st.adults > 1) { st.adults--; renderEngine(); } });
  $('#adPlus').addEventListener('click', function () { if (st.adults < ROOMS[st.room].maxAdults) { st.adults++; renderEngine(); } });
  $('#months').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-t]'); if (!b || b.disabled) return; var d = new Date(+b.dataset.t);
    if (!st.inD || st.outD || d <= st.inD) { st.inD = d; st.outD = null; }
    else if (rangeSold(st.inD, d, st.room)) { etoast(E('t_sold'), true); st.inD = d; st.outD = null; }
    else if (nightsBetween(st.inD, d) > 21) { etoast(E('t_max'), true); return; }
    else st.outD = d;
    renderEngine();
  });
  function renderCal() {
    var html = '', dows = E('dows').split(','), loc = LOC[lang];
    for (var m = 0; m < 2; m++) {
      var first = new Date(today.getFullYear(), today.getMonth() + m, 1);
      html += '<div><h4 class="mb-2 text-[13px] font-semibold capitalize text-ink">' + first.toLocaleDateString(loc, { month: 'long', year: 'numeric' }) + '</h4><div class="grid grid-cols-7 gap-1 pb-1 text-center text-[11px] font-medium text-mist/60">' + dows.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div><div class="grid grid-cols-7 gap-1">';
      for (var e = 0; e < (first.getDay() + 6) % 7; e++) html += '<span></span>';
      var dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), avg = ROOMS[st.room].base;
      for (var dd = 1; dd <= dim; dd++) {
        var d = new Date(first.getFullYear(), first.getMonth(), dd), past = d < today, so = !past && soldOut(d, st.room), p = nightly(d, st.room), edge = same(d, st.inD) || same(d, st.outD);
        var inR = st.inD && st.outD && d > st.inD && d < st.outD, canOut = so && st.inD && !st.outD && d > st.inD;
        var cls = 'grid h-12 place-content-center gap-0.5 rounded-lg text-center transition disabled:cursor-not-allowed ' + (edge ? 'bg-gold text-navy-950' : inR ? 'bg-gold/15 text-ink' : past ? 'text-mist/25' : so ? 'bg-white/[0.03] text-mist/30' : 'text-ink hover:bg-white/10');
        var pc = edge ? 'text-navy-950/70' : so ? 'text-rose-300' : p < avg * .98 ? 'text-emerald-300' : p > avg * 1.15 ? 'text-gold' : 'text-mist/70';
        var label = d.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' }) + (past ? '' : so ? ' · ' + E('leg_sold') : ' · ' + fmt(p));
        html += '<button type="button" class="' + cls + '" data-t="' + d.getTime() + '"' + ((past || (so && !canOut)) ? ' disabled' : '') + ' aria-label="' + label + '"><span class="text-[13px] font-medium leading-none">' + dd + '</span><span class="text-[10px] leading-none ' + pc + '">' + (past ? '&nbsp;' : so ? E('sold') : short(p)) + '</span></button>';
      }
      html += '</div></div>';
    }
    $('#months').innerHTML = html;
    $('#calLabel').textContent = !st.inD ? E('cal_in') : !st.outD ? E('cal_out') : E('cal_n', { n: nightsBetween(st.inD, st.outD) });
  }
  function quote() { if (!st.inD || !st.outD) return null; var n = 0, sub = 0; for (var d = new Date(st.inD); d < st.outD; d = addDays(d, 1)) { sub += nightly(d, st.room); n++; } var ex = Math.max(0, st.adults - 2) * 18 * n; return { n: n, sub: sub, ex: ex, total: sub + ex }; }
  function row(a, b, cl) { return '<div class="flex justify-between gap-3 ' + (cl || 'text-mist') + '"><span>' + a + '</span><span>' + b + '</span></div>'; }
  function renderSide() {
    var r = ROOMS[st.room], rt = roomT(st.room);
    $('#roomCard').innerHTML = '<p class="text-[12px] font-medium text-mist/70">' + r.size + ' m² · ' + esc(E('up_to', { n: r.maxAdults })) + '</p><h4 class="mt-1 font-display text-[18px] font-semibold text-ink">' + esc(rt.name) + '</h4><p class="mt-1 text-[14px] leading-relaxed">' + esc(rt.desc) + '</p><div class="mt-3 flex flex-wrap gap-1.5 text-[12px]">' + [rt.beds, E('spec1'), E('spec2'), E('spec3')].map(function (s) { return '<span class="rounded-full border border-white/10 px-2.5 py-1">' + esc(s) + '</span>'; }).join('') + '</div>';
    $('#adults').textContent = st.adults; $('#adMinus').disabled = st.adults <= 1; $('#adPlus').disabled = st.adults >= r.maxAdults;
    var x = quote(), b = $('#basket'), df = function (d) { return d.toLocaleDateString(LOC[lang], { day: 'numeric', month: 'short' }); };
    if (!x) { b.innerHTML = '<p class="text-mist/60">' + esc(E('b_empty')) + '</p>'; $('#reserveBtn').disabled = true; return; }
    $('#reserveBtn').disabled = false;
    b.innerHTML = row(df(st.inD) + ' → ' + df(st.outD), x.n + ' ' + (x.n > 1 ? E('nights') : E('night'))) + row(esc(E('b_room', { p: fmt(x.sub / x.n) })), fmt(x.sub)) + (x.ex ? row(esc(E('b_extra')), fmt(x.ex)) : '') + row(esc(E('b_ota')), '<span class="text-emerald-300">' + fmt(0) + '</span>') + row(esc(E('b_total')), fmt(x.total), 'mt-1 border-t border-white/[0.07] pt-3 text-[16px] font-semibold text-ink') + '<p class="text-[12px] text-mist/60">' + esc(E('b_tax')) + '</p>';
  }
  var et; function etoast(m, warn) { var el = $('#engineToast'); el.textContent = m; el.className = 'min-h-[1.25rem] text-[13px] font-medium ' + (warn ? 'text-rose-300' : 'text-emerald-300'); clearTimeout(et); et = setTimeout(function () { el.textContent = ''; }, 4200); }
  $('#reserveBtn').addEventListener('click', function () { var x = quote(); if (x) etoast(E('t_hold', { room: roomT(st.room).name, total: fmt(x.total) })); });
  function renderEngine() {
    $$('[role=tab]', tabs).forEach(function (b, i) { b.textContent = roomT(i).name; });
    $('#frameUrl').textContent = E('frame_url'); $('#legBest').textContent = E('leg_best'); $('#legPeak').textContent = E('leg_peak'); $('#legSold').textContent = E('leg_sold');
    $('#calHint').textContent = E('cal_hint'); $('#adultsLabel').textContent = E('adults'); $('#reserveBtn').textContent = E('reserve');
    renderCal(); renderSide();
  }
  listeners.push(renderEngine);
  $('#engineToggle').addEventListener('click', function () {
    var p = $('#enginePanel'), open = p.hidden; p.hidden = !open; this.setAttribute('aria-expanded', String(open));
    if (open) track('live_demo_interaction', { first_action: 'booking_engine' });
  });

  /* ================= Contact form → /api/contact ================= */
  var form = $('#leadForm'), started = false, loadedAt = Date.now();
  form.addEventListener('focusin', function () { if (!started) { started = true; track('contact_form_start', {}); } });
  $$('.pkg-cta').forEach(function (a) { a.addEventListener('click', function () { $('#fPkg').value = a.getAttribute('data-pkg'); }); });
  var RULES = {
    name: function (v) { return v.trim().length >= 2; },
    email: function (v) { return /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v.trim()); },
    hotel: function (v) { return v.trim().length >= 2; },
    rooms: function (v) { return !!v; },
    challenge: function (v) { return !!v; },
    whatsapp: function (v) { return !v.trim() || /^\+?[0-9 ()-]{7,20}$/.test(v.trim()); }
  };
  var ERR = { name: 'eName', email: 'eEmail', hotel: 'eHotel', rooms: 'eRooms', challenge: 'eChallenge', whatsapp: 'eWa' };
  function check(n) { var el = form.elements[n], ok = RULES[n](el.value); el.setAttribute('aria-invalid', String(!ok)); $('#' + ERR[n]).classList.toggle('show', !ok); return ok; }
  Object.keys(RULES).forEach(function (n) { form.elements[n].addEventListener('blur', function () { if (this.value || this.getAttribute('aria-invalid')) check(n); }); form.elements[n].addEventListener('change', function () { if (this.getAttribute('aria-invalid') === 'true') check(n); }); });
  function result(kind, html) {
    var r = $('#formResult');
    r.className = 'mt-6 rounded-xl border p-5 text-[14.5px] leading-relaxed ' + (kind === 'ok' ? 'border-emerald-400/30 bg-emerald-400/[0.06] text-ink' : kind === 'warn' ? 'border-gold/40 bg-gold/[0.06] text-ink' : 'border-rose-400/40 bg-rose-400/[0.06] text-ink');
    r.innerHTML = html; r.focus();
  }
  function fallbackLinks(d) {
    var body = 'Name: ' + d.name + '\nEmail: ' + d.email + '\nHotel: ' + d.hotel + '\nRooms: ' + d.rooms + '\nMain challenge: ' + d.challenge + '\nWhatsApp: ' + (d.whatsapp || '-') + '\nPackage: ' + (d.package || '-') + '\n\n' + d.message;
    var mail = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent('AXON demo request: ' + d.hotel) + '&body=' + encodeURIComponent(body);
    var wa = 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent('AXON demo request\n' + body);
    return '<div class="mt-4 flex flex-wrap gap-3"><a class="btn-gold !py-2.5" href="' + esc(mail) + '">' + L('Send by email', 'E-postayla gönderin') + '</a><a class="wa-link btn-line !py-2.5" data-fixed="1" target="_blank" rel="noopener" href="' + esc(wa) + '">' + L('Send on WhatsApp', 'WhatsApp\'tan gönderin') + '</a></div>';
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var bad = Object.keys(RULES).filter(function (n) { return !check(n); });
    if (bad.length) { form.elements[bad[0]].focus(); return; }
    var d = { name: form.elements.name.value.trim(), email: form.elements.email.value.trim(), hotel: form.elements.hotel.value.trim(), rooms: form.elements.rooms.value, challenge: form.elements.challenge.value, whatsapp: form.elements.whatsapp.value.trim(), package: form.elements['package'].value, message: form.elements.message.value.trim(), website: form.elements.website.value, ts: loadedAt, lang: lang };
    var btn = $('#leadSubmit'); btn.disabled = true; btn.textContent = L('Sending…', 'Gönderiliyor…');
    fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.j.ok) {
          track('contact_form_submit', { package: d.package || 'none', challenge: d.challenge });
          form.reset(); started = false; loadedAt = Date.now(); Object.keys(ERR).forEach(function (n) { $('#' + ERR[n]).classList.remove('show'); form.elements[n].removeAttribute('aria-invalid'); });
          result('ok', '<p class="font-semibold">' + L('Thank you, your request has been received.', 'Teşekkürler, talebiniz bize ulaştı.') + '</p><p class="mt-1 text-mist">' + L('We will reply to ' + esc(d.email) + ' within one business day.', esc(d.email) + ' adresine bir iş günü içinde dönüş yapacağız.') + '</p>');
        } else if (res.status === 400 && res.j.fields) {
          Object.keys(res.j.fields).forEach(function (n) { if (ERR[n]) { form.elements[n].setAttribute('aria-invalid', 'true'); $('#' + ERR[n]).classList.add('show'); } });
          result('err', L('Please check the highlighted fields.', 'Lütfen işaretli alanları kontrol edin.'));
        } else if (res.status === 400 && res.j.error === 'too_fast') {
          result('err', L('That was very quick. Please wait a moment and send again.', 'Çok hızlı gönderildi. Lütfen birkaç saniye bekleyip tekrar gönderin.'));
        } else if (res.status === 503 && res.j.error === 'activation_pending') {
          result('warn', '<p class="font-semibold">' + L('One-time setup: the form is waiting for activation.', 'Tek seferlik kurulum: form etkinleştirme bekliyor.') + '</p><p class="mt-1 text-mist">' + L('The site owner needs to click the activation link once. Meanwhile, send your details by email or WhatsApp.', 'Site sahibinin etkinleştirme bağlantısına bir kez tıklaması gerekiyor. Bu arada bilgilerinizi e-posta veya WhatsApp ile gönderebilirsiniz.') + '</p>' + fallbackLinks(d));
        } else if (res.status === 429) {
          result('err', '<p>' + L('Too many requests. Please try again in a few minutes, or write to us directly.', 'Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin ya da bize doğrudan yazın.') + '</p>' + fallbackLinks(d));
        } else {
          result('warn', '<p class="font-semibold">' + L('Your request was not sent.', 'Talebiniz gönderilemedi.') + '</p><p class="mt-1 text-mist">' + L('Our online form is not available right now. Your details are ready below: send them by email or WhatsApp in one tap.', 'Çevrim içi formumuz şu anda kullanılamıyor. Bilgileriniz hazır: tek dokunuşla e-posta veya WhatsApp ile gönderebilirsiniz.') + '</p>' + fallbackLinks(d));
        }
      })
      .catch(function () { result('warn', '<p class="font-semibold">' + L('Your request was not sent.', 'Talebiniz gönderilemedi.') + '</p><p class="mt-1 text-mist">' + L('There was a connection problem. Send your details by email or WhatsApp instead.', 'Bağlantı sorunu oluştu. Bilgilerinizi e-posta veya WhatsApp ile gönderin.') + '</p>' + fallbackLinks(d)); })
      .then(function () { btn.disabled = false; btn.textContent = L('Book Your Free Consultation', 'Ücretsiz görüşme planlayın'); });
  });
  listeners.push(function () { if (!$('#leadSubmit').disabled) $('#leadSubmit').textContent = L('Book Your Free Consultation', 'Ücretsiz görüşme planlayın'); });

  window.AXON_LANG = function () { return lang; };
  listeners.push(function () { if (window.AXON_SYS_REPLAY) window.AXON_SYS_REPLAY(); });
  listeners.push(function () { window.dispatchEvent(new CustomEvent('axon-lang', { detail: { lang: lang } })); });
  listeners.push(function () { if (window.AXON_NOVA_RESET) window.AXON_NOVA_RESET(); });
  window.AXON_TRACK = track;
  $('#yr').textContent = new Date().getFullYear();
  applyLang(lang);
})();

/* ---------- Hotel PMS screenshots (tabs) ---------- */
(function () {
  var img = document.getElementById('pmsShot');
  if (!img) return;
  var ALT = {
    rooms: ['AXON PMS room status screen with occupancy, cleaning and maintenance per room', 'AXON PMS oda durumu ekranı: her odanın doluluk, temizlik ve arıza durumu'],
    reservations: ['AXON PMS reservations tape chart', 'AXON PMS rezervasyon doluluk tablosu'],
    inbox: ['AXON PMS AI inbox answering a guest with verified availability and prices', 'AXON PMS AI inbox: misafire doğrulanmış müsaitlik ve fiyatla yanıt'],
    channels: ['AXON PMS channel manager for Booking.com and Expedia', 'AXON PMS Booking.com ve Expedia kanal yöneticisi'],
    reports: ['AXON PMS reports with ADR, RevPAR and occupancy', 'AXON PMS raporları: ADR, RevPAR ve doluluk']
  };
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-pms-tab]'));
  function show(k) {
    tabs.forEach(function (t) { t.setAttribute('aria-selected', t.dataset.pmsTab === k ? 'true' : 'false'); });
    img.src = 'images/pms/' + k + '.webp';
    img.alt = ALT[k][document.documentElement.lang === 'tr' ? 1 : 0];
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(t.dataset.pmsTab); });
    t.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); show(n.dataset.pmsTab);
    });
  });
})();
