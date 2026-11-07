/* محلّل بنود الفحص المُنمَّطة — public/checklist.js (نفس الملف في المتصفح والخادم) */
const C = require('../public/checklist.js');
let fail = 0;
function check(name, got, exp) {
  const bad = Object.keys(exp).filter(k => JSON.stringify(got[k]) !== JSON.stringify(exp[k]));
  if (bad.length) { fail++; console.log('FAIL', name, bad.map(k => `${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(exp[k])}`).join(' | ')); }
  else console.log('ok  ', name);
}
const P = C.parseLine;

/* أنواع البنود */
check('plain line stays a pass/fail check', P('تنظيف الفلاتر'), { t: 'تنظيف الفلاتر', type: 'check', photoReq: false, crit: false });
check('number range arabic', P('فحص ضغط الزيت [رقم 2-5 بار]'), { t: 'فحص ضغط الزيت', type: 'number', min: 2, max: 5, unit: 'بار' });
check('number max only', P('حرارة الغرفة [رقم <= 27 °م]'), { type: 'number', min: null, max: 27, unit: '°م' });
check('number min only', P('ضغط الشبكة [رقم >= 6 بار]'), { type: 'number', min: 6, max: null, unit: 'بار' });
check('number "إلى" and colon', P('ضغط [رقم: 6 إلى 10 بار]'), { type: 'number', min: 6, max: 10, unit: 'بار' });
check('number arabic digits, reversed range', P('جهد [رقم ٢٤٠-٢٢٠ فولت]'), { type: 'number', min: 220, max: 240, unit: 'فولت' });
check('number without range', P('قراءة العداد [رقم]'), { type: 'number', min: null, max: null, unit: '' });
check('choice with failing option', P('حالة السير [اختيار: جيد|متوسط|!تالف]'),
  { t: 'حالة السير', type: 'choice', options: [{ v: 'جيد', bad: false }, { v: 'متوسط', bad: false }, { v: 'تالف', bad: true }] });
check('text item', P('الرقم التسلسلي [نص]'), { t: 'الرقم التسلسلي', type: 'text' });
check('photo + critical flags', P('تسريب غاز [حرج] [صورة]'), { t: 'تسريب غاز', type: 'check', photoReq: true, crit: true });
check('english tags', P('Oil pressure [number 2-5 bar] [photo] [critical]'), { t: 'Oil pressure', type: 'number', min: 2, max: 5, unit: 'bar', photoReq: true, crit: true });
check('unknown tag kept in text', P('بند [ملاحظة عامة]'), { t: 'بند [ملاحظة عامة]', type: 'check' });
check('fromText skips blank lines', { n: C.fromText('أ\n\n  \nب [نص]\n').length }, { n: 2 });

/* التقييم */
const num = P('ضغط [رقم 2-5 بار]'), ch = P('حالة [اختيار: سليم|!تالف]'), tx = P('رقم [نص]'), ck = P('تنظيف');
check('number in range = pass', C.evaluate(num, '3.5'), { status: 'pass', value: 3.5 });
check('number above max = fail', C.evaluate(num, '5.5'), { status: 'fail', value: 5.5 });
check('number arabic digits + comma', C.evaluate(num, '٤,٥'), { status: 'pass', value: 4.5 });
check('number missing', C.evaluate(num, ''), { missing: true });
check('choice bad option = fail', C.evaluate(ch, 'تالف'), { status: 'fail' });
check('choice good option = pass', C.evaluate(ch, 'سليم'), { status: 'pass' });
check('choice missing', C.evaluate(ch, ''), { missing: true });
check('text missing', C.evaluate(tx, '  '), { missing: true });
check('text present = pass', C.evaluate(tx, 'SN-1'), { status: 'pass', value: 'SN-1' });
check('check keeps technician status', C.evaluate(ck, '', 'flagged'), { status: 'flagged' });
check('legacy item without type', C.evaluate({ t: 'قديم', done: true, v: '' }, '', 'fail'), { status: 'fail' });
check('range text', { r: C.rangeText(num), m: C.rangeText(P('x [رقم <= 27 °م]')) }, { r: '2 – 5 بار', m: '≤ 27 °م' });

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
