/* ==== بنود الفحص المُنمَّطة (Typed checklist items) ====
   تُكتب قائمة الفحص سطراً لكل بند كما كانت، مع وسوم اختيارية بين أقواس مربعة:
     فحص ضغط الزيت [رقم 2-5 بار]        رقم بمدى مقبول (خارج المدى = فشل تلقائي)
     درجة حرارة الغرفة [رقم <= 27 °م]   حد أعلى فقط (أو >= لحد أدنى)
     حالة سير المروحة [اختيار: جيد|متوسط|!تالف]   خيار يبدأ بـ ! = فشل
     الرقم التسلسلي للطفاية [نص]          نص إلزامي
     صورة لوحة التحكم [صورة]             صورة إلزامية للبند
     تسريب غاز [حرج]                     فشل البند يفتح متابعة عاجلة
   الوسوم بالعربية أو الإنجليزية: رقم/number، اختيار/choice، نص/text، صورة/photo، حرج/critical.
   البند بلا وسم = فحص مطابق/عطل/ملاحظة كما في السابق.
   ملف واحد للمتصفح (window.Checklist) والخادم (require) — بلا اعتماديات. */
(function (root) {
  'use strict';
  const TAG = /\[([^\]]*)\]/g;
  /* لا نستخدم \b: لا يعدّ الحروف العربية حروف كلمة، فنحدّ الكلمة بمسافة أو نقطتين أو نهاية النص */
  const KW = {
    number: /^(رقم|قياس|number|num)(?=\s|:|$)\s*:?\s*/i,
    choice: /^(اختيار|خيار|choice|select)(?=\s|:|$)\s*:?\s*/i,
    text: /^(نص|text)\s*:?\s*$/i,
    photo: /^(صورة|photo|image)\s*$/i,
    crit: /^(حرج|critical|crit)\s*$/i,
  };
  const toNum = s => {
    const n = Number(String(s).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,،]/g, '.'));
    return Number.isFinite(n) ? n : null;
  };
  /* "2-5 بار" | "<= 27 °م" | ">=6" | "بار" → {min,max,unit} */
  function parseRange(s) {
    let rest = String(s || '').trim(), min = null, max = null;
    let m = rest.match(/^(-?[\d٠-٩]+(?:[.,][\d٠-٩]+)?)\s*(?:-|–|—|إلى|to|~)\s*(-?[\d٠-٩]+(?:[.,][\d٠-٩]+)?)\s*/i);
    if (m) { min = toNum(m[1]); max = toNum(m[2]); rest = rest.slice(m[0].length); }
    else if ((m = rest.match(/^(<=|≤|=<|<|أقل من|حتى)\s*(-?[\d٠-٩]+(?:[.,][\d٠-٩]+)?)\s*/))) { max = toNum(m[2]); rest = rest.slice(m[0].length); }
    else if ((m = rest.match(/^(>=|≥|=>|>|أكثر من|من)\s*(-?[\d٠-٩]+(?:[.,][\d٠-٩]+)?)\s*/))) { min = toNum(m[2]); rest = rest.slice(m[0].length); }
    if (min != null && max != null && min > max) { const t = min; min = max; max = t; }
    return { min, max, unit: rest.trim() };
  }
  /* سطر واحد → بند */
  function parseLine(line) {
    const raw = String(line || '').trim();
    const it = { t: raw, type: 'check', photoReq: false, crit: false, done: false, v: '' };
    if (!raw) return null;
    let m;
    const tags = [];
    while ((m = TAG.exec(raw))) tags.push(m[1].trim());
    TAG.lastIndex = 0;
    if (!tags.length) return it;
    let known = false;
    tags.forEach(tg => {
      if (KW.photo.test(tg)) { it.photoReq = true; known = true; return; }
      if (KW.crit.test(tg)) { it.crit = true; known = true; return; }
      if (KW.text.test(tg)) { it.type = 'text'; known = true; return; }
      if (KW.number.test(tg)) {
        const r = parseRange(tg.replace(KW.number, ''));
        it.type = 'number'; it.min = r.min; it.max = r.max; it.unit = r.unit; known = true; return;
      }
      if (KW.choice.test(tg)) {
        const opts = tg.replace(KW.choice, '').split(/[|،,\/]/).map(s => s.trim()).filter(Boolean)
          .map(s => s.startsWith('!') ? { v: s.slice(1).trim(), bad: true } : { v: s, bad: false }).filter(o => o.v);
        if (opts.length) { it.type = 'choice'; it.options = opts; known = true; }
      }
    });
    /* وسوم غير مفهومة تبقى جزءاً من النص (لا نخفي ما كتبه المستخدم) */
    if (known) it.t = raw.replace(TAG, (all, inner) => {
      const s = inner.trim();
      return (KW.photo.test(s) || KW.crit.test(s) || KW.text.test(s) || KW.number.test(s) || KW.choice.test(s)) ? '' : all;
    }).replace(/\s{2,}/g, ' ').trim() || raw;
    return it;
  }
  function fromText(txt) {
    return String(txt || '').split('\n').map(parseLine).filter(Boolean);
  }
  function rangeText(c) {
    const u = c.unit ? ' ' + c.unit : '';
    if (c.min != null && c.max != null) return c.min + ' – ' + c.max + u;
    if (c.min != null) return '≥ ' + c.min + u;
    if (c.max != null) return '≤ ' + c.max + u;
    return c.unit || '';
  }
  /* الحالة المحسوبة من القيمة: number/choice/text تُحسب، و check تبقى كما اختارها الفني */
  function evaluate(c, value, chosenStatus) {
    const type = c.type || 'check';
    const v = value == null ? '' : String(value).trim();
    if (type === 'number') {
      if (v === '') return { status: '', missing: true };
      const n = toNum(v);
      if (n == null) return { status: '', missing: true };
      const out = (c.min != null && n < c.min) || (c.max != null && n > c.max);
      return { status: out ? 'fail' : 'pass', value: n };
    }
    if (type === 'choice') {
      if (!v) return { status: '', missing: true };
      const o = (c.options || []).find(x => x.v === v);
      return { status: o && o.bad ? 'fail' : 'pass', value: v };
    }
    if (type === 'text') return v ? { status: 'pass', value: v } : { status: '', missing: true };
    return { status: chosenStatus || c.status || 'pass', value: v };
  }
  const api = { parseLine, fromText, parseRange, evaluate, rangeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Checklist = api;
})(typeof self !== 'undefined' ? self : this);
