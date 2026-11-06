/* Systems showcase: tabs + scripted product mockups. Expects window.AXON_LANG() -> 'en' | 'tr'. */
(function () {
  'use strict';
  var root = document.getElementById('solutions'); if (!root) return;
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lang = function () { return (window.AXON_LANG && window.AXON_LANG()) || document.documentElement.lang || 'en'; };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  // [who, en, tr, meta]  who: g guest, a assistant, s staff, n note
  var SCRIPTS = {
    web: [
      ['g', 'Do you offer an airport transfer?', 'Havalimanından transfer var mı?'],
      ['a', 'Yes, we arrange it on request. Which date and time do you land?', 'Evet, talep üzerine ayarlıyoruz. Hangi tarihte, saat kaçta iniyorsunuz?'],
      ['g', 'December 15, at 23:40.', '15 Aralık, 23:40.'],
      ['a', 'Noted. Our team will confirm the price. May I have your name and email?', 'Not aldım. Ekibimiz ücreti onaylayacak. Adınızı ve e-postanızı alabilir miyim?'],
      ['n', 'Inquiry sent to your team', 'Talep ekibinize iletildi']
    ],
    wa: [
      ['g', 'Hi, do you have a room for 2 this weekend?', 'Merhaba, bu hafta sonu 2 kişilik oda var mı?', '02:14'],
      ['a', 'Good evening! Friday to Sunday? How many adults will stay?', 'İyi akşamlar! Cuma–pazar mı düşünüyorsunuz? Kaç yetişkin konaklayacak?', '02:14'],
      ['g', 'Yes, 2 adults. Is breakfast included?', 'Evet, 2 yetişkin. Kahvaltı dahil mi?', '02:15'],
      ['a', 'Breakfast is included in our flexible rates. I have prepared your request; our team will confirm the price first thing.', 'Esnek fiyatlarımızda kahvaltı dahil. Talebinizi hazırladım; ekibimiz sabah ilk iş fiyatı onaylayacak.', '02:15'],
      ['s', 'Good morning! This is Ayşe from reception. Your room is ready, sending the price now.', 'Günaydın! Ben resepsiyondan Ayşe. Odanız hazır, fiyatı hemen gönderiyorum.', '09:02']
    ],
    'ml-guest': [
      ['g', 'Guten Abend, haben Sie ein Zimmer vom 15. bis 18. Dezember?', 'Guten Abend, haben Sie ein Zimmer vom 15. bis 18. Dezember?'],
      ['a', 'Guten Abend! Sehr gern. Für wie viele Personen darf ich anfragen?', 'Guten Abend! Sehr gern. Für wie viele Personen darf ich anfragen?'],
      ['g', 'Zwei Erwachsene, bitte mit Frühstück.', 'Zwei Erwachsene, bitte mit Frühstück.'],
      ['a', 'Wunderbar, Frühstück ist inklusive. Ich leite Ihre Anfrage weiter.', 'Wunderbar, Frühstück ist inklusive. Ich leite Ihre Anfrage weiter.']
    ],
    'ml-staff': [
      ['g', 'Good evening, do you have a room from December 15 to 18?', 'İyi akşamlar, 15–18 Aralık için odanız var mı?'],
      ['a', 'Good evening! With pleasure. For how many guests?', 'İyi akşamlar! Memnuniyetle. Kaç kişi için soralım?'],
      ['g', 'Two adults, with breakfast please.', 'İki yetişkin, kahvaltılı olsun.'],
      ['a', 'Wonderful, breakfast is included. I am passing your request on.', 'Harika, kahvaltı dahil. Talebinizi ekibe iletiyorum.']
    ]
  };

  function bubble(m, wa) {
    var L = lang() === 'tr' ? 2 : 1, t = esc(m[L]), meta = m[3] ? '<span class="ml-2 text-[10px] opacity-60">' + m[3] + '</span>' : '';
    if (m[0] === 'n') return '<div class="bubble-in mx-auto mt-1 inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-[11.5px] font-semibold text-gold-soft">✓ ' + t + '</div>';
    if (wa) {
      var cls = m[0] === 'g' ? 'ml-auto rounded-br-sm bg-[#005c4b] text-[#fff]' : m[0] === 's' ? 'rounded-bl-sm border border-gold/40 bg-[#202c33] text-[#fff]' : 'rounded-bl-sm bg-[#202c33] text-[#fff]';
      var who = m[0] === 'a' ? '<span class="mb-0.5 block text-[10px] font-semibold text-gold/80">' + (lang() === 'tr' ? 'AXON asistan' : 'AXON assistant') + '</span>' : m[0] === 's' ? '<span class="mb-0.5 block text-[10px] font-semibold text-gold">' + (lang() === 'tr' ? 'Ayşe · Resepsiyon' : 'Ayşe · Reception') + '</span>' : '';
      return '<div class="bubble-in max-w-[86%] rounded-xl px-2.5 py-1.5 ' + cls + '">' + who + t + meta + '</div>';
    }
    var c = m[0] === 'g' ? 'ml-auto rounded-br-sm bg-silver/90 text-navy-950' : 'rounded-bl-sm border border-white/[0.07] bg-navy-800 text-ink';
    return '<div class="bubble-in max-w-[88%] rounded-2xl px-3 py-2 ' + c + '">' + t + '</div>';
  }

  var timers = [];
  function clear() { timers.forEach(clearTimeout); timers = []; }
  function play(panel) {
    clear();
    var boxes = $$('.mock-chat', panel);
    var extras = { toast: panel.querySelector('.wa-takeover'), crmToast: panel.querySelector('.crm-toast'), crmCard: panel.querySelector('.crm-card'), crmSlot: panel.querySelector('.crm-slot') };
    boxes.forEach(function (b) { b.innerHTML = ''; });
    if (extras.toast) extras.toast.classList.add('opacity-0', 'translate-y-1');
    if (extras.crmToast) { extras.crmToast.classList.add('opacity-0', 'translate-y-1'); extras.crmCard.classList.add('opacity-0'); extras.crmSlot.innerHTML = ''; }
    if (reduce) {
      boxes.forEach(function (b) { b.innerHTML = SCRIPTS[b.dataset.script].map(function (m) { return bubble(m, b.classList.contains('wa')); }).join(''); });
      if (extras.toast) extras.toast.classList.remove('opacity-0', 'translate-y-1');
      if (extras.crmToast) { extras.crmToast.classList.remove('opacity-0', 'translate-y-1'); extras.crmCard.classList.remove('opacity-0'); extras.crmSlot.innerHTML = slotHtml(); }
      return;
    }
    var t = 400;
    if (extras.crmCard) {
      timers.push(setTimeout(function () { extras.crmToast.classList.remove('opacity-0', 'translate-y-1'); }, t));
      timers.push(setTimeout(function () { extras.crmCard.classList.remove('opacity-0'); }, t + 700));
      timers.push(setTimeout(function () { extras.crmSlot.innerHTML = slotHtml(); }, t + 1600));
      timers.push(setTimeout(function () { play(panel); }, t + 9000));
      return;
    }
    var n = Math.max.apply(null, boxes.map(function (b) { return SCRIPTS[b.dataset.script].length; }));
    for (var i = 0; i < n; i++) {
      (function (i) {
        timers.push(setTimeout(function () {
          boxes.forEach(function (b) {
            var m = SCRIPTS[b.dataset.script][i]; if (!m) return;
            if (m[0] === 's' && extras.toast) extras.toast.classList.remove('opacity-0', 'translate-y-1');
            b.insertAdjacentHTML('beforeend', bubble(m, b.classList.contains('wa'))); b.scrollTop = b.scrollHeight;
          });
        }, t));
        t += 1300;
      })(i);
    }
    timers.push(setTimeout(function () { play(panel); }, t + 5000));
  }
  function slotHtml() { return '<div class="bubble-in rounded-md border border-gold/50 bg-gold/15 px-2 py-1.5 font-semibold text-gold-soft">#1042 · DE</div>'; }

  var tabs = $$('.sys-tab', root), panels = $$('.sys-panel', root), current = 0, visible = false;
  function show(i) {
    current = i;
    tabs.forEach(function (t, j) { t.setAttribute('aria-selected', String(j === i)); t.tabIndex = j === i ? 0 : -1; });
    panels.forEach(function (p, j) { p.hidden = j !== i; });
    if (visible) play(panels[i]);
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(i); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); var k = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length; tabs[k].focus(); show(k); }
    });
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { var v = es[0].isIntersecting; if (v && !visible) { visible = true; play(panels[current]); } else if (!v && visible) { visible = false; clear(); } }, { threshold: 0.2 }).observe(root);
  } else { visible = true; play(panels[0]); }
  window.AXON_SYS_REPLAY = function () { if (visible) play(panels[current]); };
  show(0);
})();
