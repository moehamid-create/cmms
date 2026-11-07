'use strict';
/* ==== استخراج بيانات الإيصالات من النص (PDF نصي أو ناتج OCR) ====
   - يطابق الكلمات المفتاحية العربية على "هيكل الحروف" (بدون نقاط) فيتحمّل أخطاء OCR الشائعة
     مثل: قاتورة/فاتورة، الضربية/الضريبة، الاحمالي/الإجمالي.
   - يزيل علامات الاتجاه الخفية (LRM/RLM…) التي يضيفها OCR حول النص اللاتيني.
   - يتحقق من اتساق المبالغ (الإجمالي = قبل الضريبة + الضريبة، أو نسبة 15%) ليستعيد
     الفاصلة العشرية التي يُسقطها OCR (48875 → 488.75).
   الوحدة نقية بلا اعتماد على الخادم — قابلة للاختبار مستقلة. */

const BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u061C]/g;
const TASHKEEL = /[\u064B-\u065F\u0670\u0640]/g;
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩', FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/* حروف فارسية/أردية تُخرجها بعض خطوط PDF والمتصفحات بدل العربية (ھ ہ ی ک) — فواتيرنا عربية، فنوحّدها */
const FA_LETTERS = /[ھہیک]/g, FA_TO_AR = { 'ھ': 'ه', 'ہ': 'ه', 'ی': 'ي', 'ک': 'ك' };
function arabicFold(s) {
  return String(s || '').replace(/[ﭐ-﷿ﹰ-ﻼ]+/g, m => m.normalize('NFKC'))   /* أشكال العرض → حروف أساسية */
    .replace(FA_LETTERS, c => FA_TO_AR[c]);
}

/* تطبيع عام للنص قبل أي تحليل — طول السطر قد يتغير هنا (NFKC يفك الحروف المركّبة) */
function prepText(text) {
  return arabicFold(String(text || '').normalize('NFKC'))
    .replace(BIDI, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[٠-٩]/g, c => String(AR_DIGITS.indexOf(c)))
    .replace(/[۰-۹]/g, c => String(FA_DIGITS.indexOf(c)))
    .replace(TASHKEEL, '')
    .replace(/٫/g, '.').replace(/٬/g, ',')
    .replace(/(?<=\d)[Oo](?=\d)/g, '0').replace(/(?<=\d)[lI|](?=\d)/g, '1')   /* أخطاء OCR داخل الأرقام */
    .replace(/(\d)[ \t]*([-/])[ \t]*(?=\d)/g, '$1$2')                           /* "2026 / 10 / 12" → "2026/10/12" */
    .replace(/[ \t\u00A0]+/g, ' ');
}

/* هيكل الحروف: كل حرف يُستبدل بممثّل مجموعته (بلا نقاط) — تحويل حرف بحرف، فتبقى المواضع متطابقة */
const SKEL_MAP = {
  'ب': 'ٮ', 'ت': 'ٮ', 'ث': 'ٮ', 'ن': 'ٮ', 'ي': 'ٮ', 'ى': 'ٮ', 'ئ': 'ٮ', 'ی': 'ٮ',
  'ج': 'ح', 'خ': 'ح', 'ذ': 'د', 'ز': 'ر', 'ش': 'س', 'ض': 'ص', 'ظ': 'ط', 'غ': 'ع',
  'ق': 'ف', 'ة': 'ه', 'ۃ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ؤ': 'و', 'ك': 'ک',
};
function skel(s) {
  let o = '';
  for (const ch of String(s)) o += SKEL_MAP[ch] || ch.toLowerCase();
  return o;
}
/* تعبير منتظم من قائمة كلمات — يُطبَّق على هيكل السطر */
function kw(words, flags) {
  const parts = words.map(w => {
    if (w instanceof RegExp) return w.source;
    return skel(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s*');
  });
  return new RegExp('(?:' + parts.join('|') + ')', flags || '');
}

const K = {
  head: kw(['فاتورة ضريبية', 'فاتورة مبسطة', 'رقم الفاتورة', 'رقم الإيصال', 'رقم الايصال', 'سند قبض', 'سند صرف',
    /tax\s*invoice/, /invoice\s*(?:no|number|#)/, /receipt\s*(?:no|number|#)/, /^\s*(?:invoice|receipt)\b/,
    /^\s*(?:فاٮوره|اٮصال)(?![؀-ۿ])/]),
  total: kw(['الإجمالي', 'الاجمالي', 'إجمالي', 'اجمالي', 'المجموع', 'الصافي', 'صافي', 'المستحق', 'المبلغ الإجمالي', 'الإجمالى', 'شامل',
    /grand\s*total/, /incl(?:uding|\.)?\s*(?:vat|tax)/, /\btotal\b/, /net\s*amount/, /amount\s*due/, /balance\s*due/, /\bnet\b/]),
  totalPref: kw(['شامل', 'المستحق', 'الصافي', 'صافي', 'النهائي', /incl/, /including/, /grand/, /\bdue\b/, /\bnet\b/, /payable/]),
  sub: kw(['قبل الضريبة', 'قبل الضريبه', 'الإجمالي قبل', 'الاجمالي قبل', /(?:^|\s)فٮل(?:\s|$|:)/, 'غير شامل', 'بدون ضريبة', 'المجموع الفرعي', 'الإجمالي الفرعي', 'الخاضع للضريبة',
    /sub\s*-?\s*total/, /excl/, /excluding/, /before\s*(?:vat|tax)/, /taxable\s*amount/, /total\s*(?:without|w\/o)/]),
  notTotal: kw([/^(?!.*ٮعد).*حصم/, /^(?!.*after).*discount/, 'الكمية', 'عدد', 'الأصناف', 'الاصناف', 'المدفوع', 'نقدا', 'نقداً', 'الباقي', 'المتبقي', 'شبكة', 'مدى',
    /\bqty\b/, /quantity/, /items?\b/, /\bpaid\b/, /\bcash\b/, /change/, /tender/, /\bcard\b/, /\bmada\b/]),
  vat: kw(['ضريبة القيمة المضافة', 'القيمة المضافة', 'ضريبة', 'الضريبة', /\bvat\b/, /\btax\b/]),
  notVat: kw(['الرقم الضريبي', 'رقم ضريبي', 'رقم التسجيل', 'فاتورة ضريبية', 'شامل', 'قبل', 'غير شامل', 'الإجمالي', 'الاجمالي', 'اجمالي', 'إجمالي',
    /vat\s*(?:no|number|reg|#|id)/, /tax\s*(?:no|number|id|reg|invoice)/, /\btrn\b/, /registration/, /incl/, /excl/, /before/, /total/]),
  vatNo: kw(['الرقم الضريبي', 'رقم ضريبي', 'رقم التسجيل الضريبي', 'الرقم الضريبى', 'رقم تسجيل ضريبة',
    /vat\s*(?:no|number|reg(?:istration)?|#|id)/, /tax\s*(?:no|number|id|reg)/, /\btrn\b/, /\btin\b/]),
  no: kw(['رقم الفاتورة', 'رقم الإيصال', 'رقم الايصال', 'رقم السند', 'رقم الطلب', 'رقم المرجع', 'فاتورة رقم', 'إيصال رقم', 'ايصال رقم', 'رقم الفاتوره',
    /(?:invoice|receipt|inv|bill|order|ref(?:erence)?|doc(?:ument)?)\s*\.?\s*(?:no\b|number|num\b|#)/, /\binv\s*#/]),
  date: kw(['التاريخ', 'تاريخ', /\bdate\b/, /\bissued?\b/]),
  dueDate: kw(['تاريخ الاستحقاق', 'تاريخ التوريد', /due\s*date/, /supply\s*date/, /expir/]),
  vendorLbl: kw(['اسم البائع', 'اسم المورد', 'اسم المنشأة', 'اسم المتجر', 'اسم الشركة', 'البائع', 'المورد',
    /seller(?:\s*name)?/, /vendor/, /supplier/, /merchant/, /company\s*name/]),
  biz: kw(['مؤسسة', 'مؤسسه', 'شركة', 'شركه', 'محل', 'محلات', 'مطعم', 'مطاعم', 'صيدلية', 'صيدليات', 'سوق', 'أسواق', 'اسواق', 'سوبر', 'هايبر',
    'مركز', 'متجر', 'مخبز', 'مخابز', 'كافيه', 'مقهى', 'معرض', 'ورشة', 'مصنع', 'بقالة', 'تموينات', 'مستودع', 'مستودعات', 'للتجارة', 'التجارية', 'للمقاولات', 'مكتب',
    /\btrading\b/, /\best\.?\b/, /\bcompany\b/, /\bco\./, /\bltd\b/, /\bllc\b/, /\bstores?\b/, /\bmarket\b/, /\bmart\b/, /pharmacy/, /restaurant/,
    /\bcafe\b/, /coffee/, /bakery/, /\bcent(?:er|re)\b/, /hypermarket/, /supermarket/, /\bgroup\b/, /\bservices\b/, /contracting/]),
  notVendor: kw(['فاتورة', 'فاتوره', 'إيصال', 'ايصال', 'ضريبة', 'ضريبي', 'رقم', 'تاريخ', 'التاريخ', 'الوقت', 'هاتف', 'جوال', 'تليفون', 'سجل تجاري', 'السجل',
    'مبسطة', 'كاشير', 'الكاشير', 'فرع', 'العميل', 'عميل', 'الكمية', 'السعر', 'الإجمالي', 'الاجمالي', 'المجموع', 'شكرا', 'العنوان', 'ص.ب', 'الرمز البريدي',
    /invoice/, /receipt/, /\btax\b/, /\bvat\b/, /\bno\b/, /date/, /time/, /\btel\b/, /phone/, /mobile/, /\bc\.?r\b/, /simplified/, /cashier/, /branch/,
    /customer/, /\bqty\b/, /price/, /total/, /www/, /http/, /@/, /thank/, /address/, /p\.?o\.?\s*box/]),
  items: kw(['الصنف', 'الأصناف', 'الاصناف', 'البيان', 'الوصف', 'الكمية', 'سعر الوحدة', /\bitems?\b/, /description/, /\bqty\b/, /quantity/, /unit\s*price/]),
  footer: kw(['شكرا', 'شكراً', 'نشكركم', 'صفحة', /thank\s*you/, /page\s*\d/, /www\./, /https?:/]),
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const AR_MONTHS = [['يناير', 1], ['فبراير', 2], ['مارس', 3], ['أبريل', 4], ['ابريل', 4], ['إبريل', 4], ['مايو', 5], ['يونيو', 6], ['يوليو', 7],
  ['أغسطس', 8], ['اغسطس', 8], ['سبتمبر', 9], ['أكتوبر', 10], ['اكتوبر', 10], ['نوفمبر', 11], ['ديسمبر', 12],
  ['كانون الثاني', 1], ['شباط', 2], ['آذار', 3], ['نيسان', 4], ['أيار', 5], ['حزيران', 6], ['تموز', 7], ['آب', 8], ['أيلول', 9],
  ['تشرين الأول', 10], ['تشرين الثاني', 11], ['كانون الأول', 12]];

function normDateStr(s) {
  const a = String(s || '').split(/[-/.]/).map(x => x.trim());
  if (a.length !== 3 || a.some(x => !/^\d+$/.test(x))) return '';
  let y, m, d;
  if (a[0].length === 4) { y = a[0]; m = a[1]; d = a[2]; }
  else { d = a[0]; m = a[1]; y = a[2]; if (y.length === 2) y = '20' + y; }
  if (y.length !== 4) return '';
  m = String(+m).padStart(2, '0'); d = String(+d).padStart(2, '0');
  if (+m > 12 && +d <= 12) { const x = m; m = d; d = x; }   /* صيغة أمريكية mm/dd */
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return '';
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCDate() !== +d) return '';                    /* 31/02 مثلاً */
  return y + '-' + m + '-' + d;
}

/* قيمة رقمية من نص مالي: يفهم 1,234.50 و 1.234,50 و 488,75 */
function num(s) {
  let x = String(s == null ? '' : s).replace(/[^\d.,-]/g, '');
  if (!x) return null;
  if (x.indexOf('.') >= 0 && x.indexOf(',') >= 0) {
    x = x.lastIndexOf('.') > x.lastIndexOf(',') ? x.replace(/,/g, '') : x.replace(/\./g, '').replace(/,/g, '.');
  } else if (x.indexOf(',') >= 0) {
    const p = x.split(','); x = (p.length === 2 && p[1].length <= 2) ? p[0] + '.' + p[1] : x.replace(/,/g, '');
  } else if ((x.match(/\./g) || []).length > 1) {
    const p = x.split('.'); const last = p.pop(); x = p.join('') + (last.length <= 2 ? '.' + last : last);
  }
  const n = parseFloat(x); return isFinite(n) ? n : null;
}

/* الأرقام المالية في سطر — تُستبعد التواريخ والأوقات والنسب والأرقام الطويلة (هاتف/رقم ضريبي) */
function moneyTokens(line) {
  const s = String(line)
    .replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/g, ' ')
    .replace(/(?<![\d.,])\d{1,2}:[0-5]\d(?::[0-5]\d)?(?![.,]?\d)(?:\s*[ap]\.?m\.?)?/gi, ' ')   /* وقت مستقل فقط — لا يقتطع "15:63.75" */
    .replace(/[A-Za-z]+[-#/]\d[\w\-/]*/g, ' ');                 /* رموز مثل INV-123 */
  const out = [];
  for (const m of s.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const raw = m[0], after = s.slice(m.index + raw.length, m.index + raw.length + 3);
    if (/^\s*[%٪]/.test(after)) continue;
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    if (/[%٪]\s*$/.test(before) && raw.length <= 2) continue;
    if (raw.replace(/\D/g, '').length > 10) continue;
    const v = num(raw); if (v == null) continue;
    out.push({ raw, v, dec: /[.,]\d{1,2}$/.test(raw) });
  }
  return out;
}

const VAT_RATES = [0.15, 0.05, 0.14, 0.10];

/* المبالغ: يجمع المرشّحين (إجمالي/قبل الضريبة/ضريبة) ويختار التركيبة المتسقة حسابياً */
function pickAmounts(lines, skels) {
  const usesDec = lines.some(l => /\d[.,]\d{2}\b/.test(l));
  const cands = { tot: [], sub: [], vat: [] };
  const variants = (tok) => {
    const vs = [{ v: tok.v, fixed: false }];
    if (usesDec && !tok.dec && /^\d{3,9}$/.test(tok.raw)) vs.push({ v: tok.v / 100, fixed: true });   /* فاصلة عشرية أسقطها OCR */
    return vs;
  };
  const take = (i) => {
    let t = moneyTokens(lines[i]);
    if (!t.length && i + 1 < lines.length && !/[A-Za-z\u0600-\u06FF]{3}/.test(lines[i + 1])) t = moneyTokens(lines[i + 1]);
    return t;
  };
  lines.forEach((l, i) => {
    const k = skels[i];
    const isSub = K.sub.test(k);
    const isTot = K.total.test(k) && !K.notTotal.test(k);
    const isVat = K.vat.test(k) && !K.notVat.test(k) && !K.vatNo.test(k);
    if (isSub) take(i).forEach(t => variants(t).forEach(x => cands.sub.push(Object.assign({ line: i }, x))));
    else if (isTot) {
      const pref = K.totalPref.test(k);
      take(i).forEach(t => variants(t).forEach(x => cands.tot.push(Object.assign({ line: i, pref }, x))));
    }
    if (isVat && !isSub) take(i).forEach(t => variants(t).forEach(x => cands.vat.push(Object.assign({ line: i }, x))));
  });
  /* معقولية الحجم: الإجمالي لا يكون أصغر بكثير ولا أكبر بكثير من بقية المبالغ العشرية في الإيصال */
  const decVals = lines.flatMap(l => moneyTokens(l)).filter(t => t.dec && t.v > 0).map(t => t.v);
  const M = decVals.length ? Math.max.apply(null, decVals) : 0;
  const plaus = v => (M > 0 && (v > M * 20 || v < M * 0.05)) ? -3 : 0;
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.0002);
  let best = null;
  const consider = (score, t, v, s) => { if (!best || score > best.score) best = { score, t, v, s }; };
  for (const t of cands.tot) {
    if (!(t.v > 0)) continue;
    const base = (t.pref ? 2 : 0) + (t.fixed ? -1.5 : 0) + plaus(t.v) + t.line / 1000 + Math.min(t.v, 1e7) / 1e10;
    let matched = false;
    for (const v of cands.vat) {
      if (!(v.v > 0) || v.v >= t.v) continue;
      for (const s of cands.sub) {
        if (near(s.v + v.v, t.v)) { consider(10 + base - (v.fixed ? 1 : 0) - (s.fixed ? 1 : 0) + plaus(s.v), t.v, v.v, s.v); matched = true; }
      }
      if (VAT_RATES.some(r => near(t.v * r / (1 + r), v.v))) { consider(8 + base - (v.fixed ? 1 : 0), t.v, v.v, null); matched = true; }
    }
    for (const s of cands.sub) {
      if (!(s.v > 0) || s.v >= t.v) continue;
      if (VAT_RATES.some(r => near(s.v * (1 + r), t.v))) { consider(7 + base - (s.fixed ? 1 : 0) + plaus(s.v), t.v, +(t.v - s.v).toFixed(2), s.v); matched = true; }
    }
    if (!matched) consider(base + (t.fixed ? -5 : 0), t.v, null, null);
  }
  /* بلا إجمالي متسق: الضريبة + قبل الضريبة تكفيان */
  if (!best || best.score < 7) {
    for (const v of cands.vat) for (const s of cands.sub) {
      if (v.v > 0 && s.v > v.v && VAT_RATES.some(r => near(s.v * r, v.v))) {
        const sc = 6.5 - (v.fixed ? 1 : 0) - (s.fixed ? 1 : 0);
        if (!best || sc > best.score) best = { score: sc, t: +(s.v + v.v).toFixed(2), v: v.v, s: s.v };
      }
    }
  }
  const out = {};
  if (best && best.score > -3) {
    out.amount = +best.t.toFixed(2);
    if (best.v != null) out.vat = +best.v.toFixed(2);
    if (best.s != null) out.subtotal = +best.s.toFixed(2);
    out.checked = best.score >= 6.5;        /* المبالغ متسقة حسابياً */
  }
  /* الضريبة من سطرها وإن لم تتسق (أول قيمة غير مصحّحة) */
  if (out.vat == null) {
    const v = cands.vat.filter(x => !x.fixed && x.v > 0 && (out.amount == null || x.v < out.amount));
    if (v.length) out.vat = v[v.length - 1].v;
  }
  if (out.amount == null) {
    /* آخر حل: أكبر مبلغ بكسرين عشريين في النص */
    const all = lines.flatMap(l => moneyTokens(l)).filter(t => t.dec).map(t => t.v);
    if (all.length) out.amount = Math.max.apply(null, all);
  }
  return out;
}

function findDate(lines, skels, flat) {
  const DRE = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/g;
  const valid = raw => { const d = normDateStr(raw); return d && +d.slice(0, 4) >= 2000 && +d.slice(0, 4) <= 2100 ? d : ''; };
  const scored = [];
  lines.forEach((l, i) => {
    const k = skels[i];
    const lab = K.date.test(k) && !K.dueDate.test(k);
    const hijri = /\d\s*ه(?![؀-ۿ])|hijri|هجري/i.test(l);
    for (const m of l.matchAll(DRE)) {
      const d = valid(m[1]); if (!d) continue;
      scored.push({ d, raw: m[1], s: (lab ? 10 : 0) - (K.dueDate.test(k) ? 5 : 0) - (hijri ? 20 : 0) - i * 0.01 });
    }
    /* أسماء الأشهر: 12 Oct 2026 / Oct 12, 2026 / 12 أكتوبر 2026 */
    const en = l.match(/\b(\d{1,2})[ -]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[ ,-]*(\d{4})\b/i)
      || l.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[ .-]*(\d{1,2}),?[ ]*(\d{4})\b/i);
    if (en) {
      const named = isNaN(+en[1]); const dd = named ? en[2] : en[1], mm = MONTHS[(named ? en[1] : en[2]).toLowerCase().slice(0, 3)];
      const d = valid(en[3] + '-' + mm + '-' + dd); if (d) scored.push({ d, raw: en[0], s: (lab ? 10 : 0) + 1 - i * 0.01 });
    }
    for (const [name, mm] of AR_MONTHS) {
      const re = new RegExp('(\\d{1,2})\\s*' + name.replace(/ /g, '\\s*') + '\\s*,?\\s*(\\d{4})');
      const am = l.match(re);
      if (am) { const d = valid(am[2] + '-' + mm + '-' + am[1]); if (d) scored.push({ d, raw: am[0], s: (lab ? 10 : 0) + 1 - i * 0.01 }); }
    }
  });
  if (!scored.length) {
    const iso = flat.match(/(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/);
    if (iso) { const d = valid(iso[1]); if (d) return { date: d, dateRaw: iso[0] }; }
    return {};
  }
  scored.sort((a, b) => b.s - a.s);
  return { date: scored[0].d, dateRaw: scored[0].raw };
}

function findReceiptNo(lines, skels) {
  const TOK = /[A-Za-z]{0,6}[-#/]?\d[A-Za-z0-9\-/]*/g;
  const good = t => {
    const digits = t.replace(/\D/g, '');
    if (!digits.length || digits.length >= 15) return false;
    if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(t)) return false;    /* تاريخ */
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const k = skels[i], m = k.match(K.no);
    if (!m) continue;
    const l = lines[i];
    const after = l.slice(m.index + m[0].length), before = l.slice(0, m.index);
    const a = (after.match(TOK) || []).filter(good), b = (before.match(TOK) || []).filter(good);
    const pick = a[0] || b[b.length - 1];
    if (pick) return pick.replace(/^[-#/]+|[-/]+$/g, '').slice(0, 40);
    /* القيمة في السطر التالي */
    const nx = lines[i + 1] || '';
    const n = (nx.match(TOK) || []).filter(good);
    if (n.length && nx.replace(/[\s:#]/g, '').length <= n[0].length + 4) return n[0].slice(0, 40);
  }
  /* "No: 12345" / "#12345" قرب أعلى الإيصال */
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const m = lines[i].match(/(?:^|\s)(?:no\.?|#)\s*[:.]?\s*([A-Za-z]{0,4}-?\d[\w\-/]*)/i);
    if (m && good(m[1])) return m[1].slice(0, 40);
  }
  /* تسمية مشوّهة بالـ OCR ("رقم القتررة"): سطر فيه "رقم" ورمز — وليس رقماً ضريبياً/هاتفاً/سجلاً */
  const OTHER = kw(['ضريبي', 'هاتف', 'جوال', 'سجل', 'الجوال', 'العميل', 'الحساب', 'الآيبان', /vat/, /tax/, /tel/, /phone/, /c\.?r/, /iban/, /account/]);
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (!/(?:^|\s)رفم/.test(skels[i]) || OTHER.test(skels[i])) continue;
    const t = (lines[i].match(TOK) || []).filter(good);
    if (t.length) return t[0].slice(0, 40);
  }
  /* رمز فاتورة مستقل بلا تسمية: INV-10234 / SIN-2026-0042 */
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const m = lines[i].match(/(?:^|[^A-Za-z])((?:INV|SIN|SI|TI|RCPT|RCT|REC|BILL|ORD|SO|PO|CI|TX)[-/#]?\d{3,}[\w\-/]*)/i);
    if (m && good(m[1]) && !K.vatNo.test(skels[i])) return m[1].slice(0, 40);
  }
  return '';
}

function findVatNo(lines, skels, flat) {
  for (let i = 0; i < lines.length; i++) {
    if (!K.vatNo.test(skels[i])) continue;
    const cand = (lines[i] + ' ' + (lines[i + 1] || '')).match(/\d[\d \-]{9,24}\d/g) || [];
    for (const c of cand) { const d = c.replace(/\D/g, ''); if (d.length >= 10 && d.length <= 20) return d; }
  }
  const z = flat.replace(/(?<=\d) (?=\d)/g, '').match(/(?<!\d)(3\d{13}3)(?!\d)/);   /* الرقم الضريبي السعودي: 15 رقماً تبدأ وتنتهي بـ 3 */
  return z ? z[1] : '';
}

function findVendor(lines, skels, opts) {
  const LET = /[A-Za-z\u0621-\u064A\u0671-\u06D3]/g;
  const clean = x => String(x || '')
    .replace(/^[^A-Za-z\u0621-\u064A\u0671-\u06D3]+|[^A-Za-z\u0621-\u064A\u0671-\u06D3.)]+$/g, '')
    .replace(/\s*[-\u2010\u2013|]\s*(?:فرع|branch\b).*$/i, '')
    .replace(/\s{2,}/g, ' ').trim().slice(0, 120);
  /* موسوم: "اسم البائع: …" */
  for (let i = 0; i < lines.length; i++) {
    const m = skels[i].match(K.vendorLbl);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length).replace(/^\s*[:：\-]\s*/, '');
    const v = clean(rest);
    if (v.length >= 3 && !K.notVendor.test(skel(v))) return v;
  }
  const arabicDoc = (lines.join(' ').match(/[\u0621-\u064A]/g) || []).length > (lines.join(' ').match(/[A-Za-z]/g) || []).length;
  const conf = (opts && opts.lineConf) || null;
  let best = null;
  /* اسم المورّد في رأس الإيصال: نتوقف عند جدول الأصناف أو أول مبلغ */
  let top = Math.min(lines.length, 12);
  for (let i = 0; i < top; i++) {
    if (i > 0 && (K.items.test(skels[i]) || moneyTokens(lines[i]).some(t => t.dec))) { top = i; break; }
  }
  for (let i = 0; i < top; i++) {
    const c = clean(lines[i]); if (c.length < 3 || c.length > 70) continue;
    const k = skel(c);
    const letters = (c.match(LET) || []).length, dense = letters / Math.max(1, c.replace(/\s/g, '').length);
    if (letters < 4 || dense < 0.7) continue;
    const biz = K.biz.test(k);
    if (K.notVendor.test(k) && !biz) continue;
    if (K.footer.test(k)) continue;
    const words = c.split(/\s+/), shortW = words.filter(w => w.replace(LET, 'x').length <= 1).length;
    let s = 10 - i * 0.8 + (biz ? 6 : 0);
    if (shortW / words.length > 0.4) s -= 4;                               /* حروف متناثرة = ضجيج OCR */
    const isLatin = !/[\u0621-\u064A]/.test(c);
    if (arabicDoc && isLatin && !biz) s -= 6;                             /* سطر لاتيني وسط إيصال عربي غالباً ضجيج */
    if (conf && conf[i] != null) s += (conf[i] - 70) / 10;
    if (/(فاتور|invoice)/i.test(c)) s -= 6;
    if (!best || s > best.s) best = { s, v: c };
  }
  return best && best.s >= 4 ? best.v : '';
}

function extractReceiptFields(text, opts) {
  const t = prepText(text);
  const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
  const skels = lines.map(skel);
  const flat = lines.join('\n');
  const f = {};
  Object.assign(f, findDate(lines, skels, flat));
  const no = findReceiptNo(lines, skels); if (no) f.no = no;
  const a = pickAmounts(lines, skels);
  if (a.amount != null) f.amount = a.amount;
  if (a.vat != null && (f.amount == null || a.vat < f.amount)) f.vat = a.vat;
  if (a.subtotal != null) f.subtotal = a.subtotal;
  if (a.checked) f.checked = true;
  const vn = findVatNo(lines, skels, flat); if (vn) f.supplierNo = vn;
  const ph = flat.match(/(?:tel|phone|mobile|هاتف|جوال|تليفون|ت\s*:)[^\n\d+]{0,6}([+\d][\d \-()]{6,})/i);
  if (ph) f.phone = String(ph[1]).trim().slice(0, 25);
  if (/ر\.?\s?س|ريال|SAR|\bSR\b|\u20C1/i.test(flat)) f.currency = 'SAR';
  else if (/AED|درهم|د\.إ/i.test(flat)) f.currency = 'AED';
  else if (/EGP|جنيه|ج\.م/i.test(flat)) f.currency = 'EGP';
  else if (/€|EUR|يورو/i.test(flat)) f.currency = 'EUR';
  else if (/\$|USD|دولار/i.test(flat)) f.currency = 'USD';
  else if (f.supplierNo && /^3\d{13}3$/.test(f.supplierNo)) f.currency = 'SAR';
  const v = findVendor(lines, skels, opts); if (v) f.vendor = v;
  return f;
}

/* ---- تقسيم نص صفحات ملف إلى إيصالات: صفحة لكل إيصال افتراضياً، وتُقسَم الصفحة
   إن احتوت أكثر من رأس إيصال يفصل بينهما سطر إجمالي، وتُدمج صفحة التتمة (بلا رأس)
   مع ما قبلها إن لم يكن له إجمالي بعد. ---- */
function splitReceiptText(pages) {
  const segs = [];
  const isHead = l => K.head.test(skel(prepText(l)));
  const isTot = l => { const k = skel(prepText(l)); return K.total.test(k) && !K.notTotal.test(k); };
  const isFoot = l => K.footer.test(skel(prepText(l)));
  pages.forEach((txt, pi) => {
    const lines = String(txt || '').split('\n');
    if (!lines.some(l => l.trim())) return;
    const heads = [];
    lines.forEach((l, k) => { if (isHead(l) && (!heads.length || k - heads[heads.length - 1] > 3)) heads.push(k); });
    const cuts = [0];
    for (let h = 1; h < heads.length; h++) {
      const from = cuts[cuts.length - 1];
      let lastTot = -1;
      for (let k = from; k < heads[h]; k++) if (isTot(lines[k])) lastTot = k;
      if (lastTot < 0) continue;
      let cut = Math.max(lastTot + 1, heads[h] - 3);
      while (cut < heads[h] && (isFoot(lines[cut]) || !lines[cut].trim())) cut++;   /* تذييل الإيصال السابق يبقى معه */
      cuts.push(cut);
    }
    cuts.forEach((c, ci) => {
      const text = lines.slice(c, ci + 1 < cuts.length ? cuts[ci + 1] : lines.length).join('\n').trim();
      if (!text) return;
      const prev = segs[segs.length - 1];
      if (ci === 0 && prev && !text.split('\n').some(isHead) && !prev.text.split('\n').some(isTot)) {
        prev.text += '\n' + text; prev.pageTo = pi + 1;
      } else segs.push({ pageFrom: pi + 1, pageTo: pi + 1, text });
    });
  });
  return segs;
}

/* ---- جودة نص صفحة PDF: هل النص المضمّن صالح أم يلزم OCR؟ ----
   الماسحات الضوئية كثيراً ما تضيف طبقة نص مخفية رديئة (إنجليزية فقط أو رموز مشوّهة). */
function pageTextQuality(txt) {
  const s = String(txt || '').normalize('NFKC').replace(BIDI, '');
  const nonSpace = s.replace(/\s/g, '');
  const letters = (s.match(/[A-Za-z\u0621-\u064A\u0671-\u06D3]/g) || []).length;
  const digits = (s.match(/\d/g) || []).length;
  const weird = (s.match(/[\uE000-\uF8FF\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length;
  const prepared = prepText(s), k = skel(prepared);
  const hits = [K.total, K.vat, K.head, K.date, K.no, K.vatNo].filter(r => r.test(k)).length;
  const words = prepared.split(/\s+/).filter(w => /[A-Za-z\u0621-\u064A]{2,}/.test(w));
  const avgW = words.length ? words.reduce((a, w) => a + w.length, 0) / words.length : 0;
  const money = (prepared.match(/\d+[.,]\d{2}\b/g) || []).length;
  let needOcr = false, reason = '';
  if (nonSpace.length < 20 || letters + digits < 15) { needOcr = true; reason = 'empty'; }
  else if (weird / Math.max(1, nonSpace.length) > 0.05) { needOcr = true; reason = 'garbled'; }
  else if ((letters + digits) / Math.max(1, nonSpace.length) < 0.5) { needOcr = true; reason = 'symbols'; }
  else if (!hits && money < 1) { needOcr = true; reason = 'no-keywords'; }
  else if (avgW < 2.2 && words.length > 8) { needOcr = true; reason = 'fragments'; }
  return { chars: nonSpace.length, hits, needOcr, reason };
}

/* ---- نص صفحة PDF من عناصر pdf.js (getTextContent().items) ----
   ملفات PDF المطبوعة من المتصفح (Edge/Chrome) ترسم كل حرف عربي مُشكَّل عنصراً مستقلاً، والمسافة عنصراً مستقلاً " ".
   لذلك لا نضع مسافة بين كل عنصرين، بل نقرّرها من الفجوة الأفقية الفعلية: حروف متلاصقة = كلمة واحدة،
   وعنصر مسافة أو فجوة أعرض من ~12% من حجم الخط = كلمة جديدة. العربية (ومنها أشكال العرض U+FB50–FEFF) تُرتَّب من اليمين. */
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
function joinTextRow(items, rtl) {
  const list = items.slice().sort((a, b) => rtl ? b.x - a.x : a.x - b.x);
  let out = '', prev = null, pendingSpace = false;
  for (const it of list) {
    if (!String(it.s).trim()) { if (prev) pendingSpace = true; continue; }   /* عنصر مسافة: علامة فصل فقط */
    if (prev) {
      const w = prev.w, cw = it.w;
      let gap = Infinity;
      if (w > 0 && cw > 0) gap = rtl ? prev.x - (it.x + cw) : it.x - (prev.x + w);
      const size = Math.max(prev.h || 0, it.h || 0, 4);
      if (pendingSpace || !(gap < size * 0.12)) out += ' ';   /* عرض مجهول (0) = نفصل كالسابق */
    }
    out += it.s;
    prev = it; pendingSpace = false;
  }
  return arabicFold(out).replace(/[ \t]{2,}/g, ' ').trim();
}
function pageTextFromItems(items) {
  const rows = [];
  (items || []).forEach(it => {
    const s = it && typeof it.str === 'string' ? it.str : '';
    if (!s) return;
    const tr = it.transform || [];
    const x = tr[4] || 0, y = tr[5] || 0;
    const h = Math.abs(it.height || tr[3] || 0);
    const tol = Math.max(2, h || 8) * 0.5;
    let row = rows.find(r => Math.abs(r.y - y) <= Math.max(tol, r.tol));
    if (!row) { row = { y, tol, items: [] }; rows.push(row); }
    row.items.push({ x, w: Math.abs(it.width || 0), h, s, dir: it.dir });
  });
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    const rtl = r.items.some(t => RTL_CHARS.test(t.s));
    return joinTextRow(r.items, rtl);
  }).filter(Boolean).join('\n');
}

/* ---- نوع الملف من بايتاته الأولى (لا نثق برأس Content-Type وحده) ---- */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return '';
  const h = buf.slice(0, 16), ascii = h.toString('latin1');
  if (ascii.startsWith('%PDF') || buf.slice(0, 1024).toString('latin1').includes('%PDF-')) return 'application/pdf';
  if (h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return 'image/jpeg';
  if (h[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'image/png';
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('BM')) return 'image/bmp';
  if (ascii.startsWith('II*\0') || ascii.startsWith('MM\0*')) return 'image/tiff';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
  }
  return '';
}

module.exports = { prepText, skel, normDateStr, num, moneyTokens, extractReceiptFields, splitReceiptText, pageTextQuality, sniffMime, joinTextRow, pageTextFromItems, arabicFold };
