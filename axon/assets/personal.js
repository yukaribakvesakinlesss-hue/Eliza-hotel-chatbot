/* Nova personal assistant demo: tabs, finance bars, approvals and scripted replies (simulation). */
(function () {
  'use strict';
  var root = document.getElementById('nova'); if (!root) return;
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var lang = function () { return (window.AXON_LANG && window.AXON_LANG()) || document.documentElement.lang || 'en'; };
  var L = function (en, tr) { return lang() === 'tr' ? tr : en; };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // tabs
  var tabs = $$('.nv-tab', root), panels = $$('.nv-panel', root);
  function show(i) {
    tabs.forEach(function (t, j) { t.setAttribute('aria-selected', String(j === i)); });
    panels.forEach(function (p, j) { p.classList.toggle('hidden', j !== i); });
  }
  tabs.forEach(function (t, i) { t.addEventListener('click', function () { show(i); }); });

  // finance bars (sample data)
  var INC = [62, 70, 66, 78, 74, 88], EXP = [48, 52, 50, 55, 61, 58];
  document.getElementById('nvBars').innerHTML = INC.map(function (v, i) {
    return '<div class="flex h-full flex-1 items-end gap-1"><span class="w-1/2 rounded-t bg-gold" style="height:' + v + '%"></span><span class="w-1/2 rounded-t bg-silver/50" style="height:' + EXP[i] + '%"></span></div>';
  }).join('');

  // approvals
  root.addEventListener('click', function (e) {
    var b = e.target.closest('.nv-approve'); if (!b || b.disabled) return;
    b.disabled = true; b.textContent = L('Sent ✓', 'Gönderildi ✓'); b.classList.add('done');
    say(L('Done. I sent it in your name and will tell you as soon as they reply.', 'Tamam. Sizin adınıza gönderdim; cevap gelir gelmez size haber vereceğim.'));
  });

  // scripted conversation
  var chat = document.getElementById('nvChat');
  function bubble(text, me) {
    chat.insertAdjacentHTML('beforeend', '<div class="bubble-in ' + (me ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-silver/90 px-3.5 py-2 text-navy-950' : 'max-w-[92%] rounded-2xl rounded-bl-md border border-gold/25 bg-gold/[0.07] px-3.5 py-2 text-ink') + '">' + esc(text) + '</div>');
    chat.scrollTop = chat.scrollHeight;
  }
  var busy = false;
  function say(text) {
    if (reduce) { bubble(text); return; }
    chat.insertAdjacentHTML('beforeend', '<div class="typing flex gap-1 px-1 py-2" id="nvTyping"><i></i><i></i><i></i></div>'); chat.scrollTop = chat.scrollHeight;
    setTimeout(function () { var t = document.getElementById('nvTyping'); if (t) t.remove(); bubble(text); busy = false; }, 900);
  }
  var CMDS = [
    { en: 'Plan my day tomorrow', tr: 'Yarınki günümü planla', tab: 0,
      a: ['Tomorrow: 09:00 team stand-up, 11:30 bank meeting, 15:00 site visit. I kept 13:00–14:00 free for lunch and moved the supplier call to Thursday so nothing clashes.', 'Yarın: 09:00 ekip toplantısı, 11:30 banka görüşmesi, 15:00 tesis ziyareti. 13:00–14:00 arasını öğle için boş bıraktım, tedarikçi aramasını çakışmasın diye perşembeye aldım.'] },
    { en: 'Summarise this month\'s income and expenses', tr: 'Bu ayın gelir-giderini özetle', tab: 1,
      a: ['This month: income ₺412,000, expenses ₺286,000, net ₺126,000 (92% of target). Energy is 14% above average; I prepared a breakdown. The supplier payment on Friday is waiting for your approval.', 'Bu ay: gelir ₺412.000, gider ₺286.000, net ₺126.000 (hedefin %92\'si). Enerji gideri ortalamanın %14 üstünde, ayrıntısını hazırladım. Cuma günkü tedarikçi ödemesi onayınızı bekliyor.'] },
    { en: 'Remind Ahmet Yılmaz about the proposal', tr: 'Ahmet Yılmaz\'a teklifi hatırlat', tab: 2,
      a: ['Draft ready: "Hello Ahmet, I wanted to check whether you had a chance to review our proposal. I am happy to answer any questions." Shall I send it on WhatsApp?', 'Taslak hazır: "Merhaba Ahmet Bey, teklifimizi inceleme fırsatınız oldu mu? Sorularınız varsa memnuniyetle cevaplarım." WhatsApp\'tan göndereyim mi?'] },
    { en: 'Book a meeting with the accountant on Thursday at 14:00', tr: 'Perşembe 14:00\'te muhasebeciyle toplantı ayarla', tab: 0,
      a: ['Thursday 14:00 is free on both calendars. I sent the invite to Merve Öz and will remind you at 13:30 with the VAT document list.', 'Perşembe 14:00 iki takvimde de boş. Merve Hanım\'a davet gönderdim; 13:30\'da KDV belge listesiyle size hatırlatacağım.'] },
    { en: 'What needs my attention today?', tr: 'Bugün neye dikkat etmeliyim?', tab: 0,
      a: ['Three things: the electricity bill is 14% higher than usual, two team tasks are late, and Ahmet Yılmaz still hasn\'t replied to the proposal. Everything else is on track.', 'Üç şey: elektrik faturası her zamankinden %14 yüksek, ekipte iki görev gecikti ve Ahmet Bey teklife hâlâ dönmedi. Geri kalan her şey yolunda.'] }
  ];
  function renderChips() {
    document.getElementById('nvChips').innerHTML = CMDS.map(function (c, i) {
      return '<button type="button" class="flex-none rounded-full border border-white/10 bg-navy-800 px-3.5 py-2 text-[13px] text-ink transition hover:border-gold/40" data-c="' + i + '">' + esc(L(c.en, c.tr)) + '</button>';
    }).join('');
  }
  document.getElementById('nvChips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-c]'); if (!b || busy) return; busy = true;
    var c = CMDS[+b.dataset.c]; show(c.tab); bubble(L(c.en, c.tr), true); say(L(c.a[0], c.a[1]));
    if (window.AXON_TRACK) window.AXON_TRACK('live_demo_interaction', { first_action: 'personal_assistant' });
  });
  function reset() {
    chat.innerHTML = ''; renderChips();
    bubble(L('Good morning. You have 5 items today and 4 replies waiting for your approval. Where shall I start?', 'Günaydın. Bugün 5 maddeniz ve onayınızı bekleyen 4 yanıt var. Nereden başlayalım?'));
    var d = new Date(); document.getElementById('nvDate').textContent = d.toLocaleDateString(lang() === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'long', weekday: 'long' });
    $$('.nv-approve', root).forEach(function (b) { b.disabled = false; b.classList.remove('done'); b.textContent = L('Approve', 'Onayla'); });
  }
  window.AXON_NOVA_RESET = reset;
  reset();
})();
