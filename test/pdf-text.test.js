/* اختبار على ملف PDF حقيقي: فاتورتان (عربية وإنجليزية) مطبوعتان من Edge — test/fixtures/receipt-ar-en.pdf
   المصدر: test/fixtures/receipt-ar-en.html (أُعيد التوليد بـ msedge --headless --print-to-pdf).
   يمرّ عبر نفس خطوات الخادم: pdf.js → pageTextFromItems → splitReceiptText → extractReceiptFields. */
const fs = require('fs');
const path = require('path');
const R = require('../receipts.js');
let fail = 0;
function check(name, got, exp) {
  const bad = Object.keys(exp).filter(k => JSON.stringify(got[k]) !== JSON.stringify(exp[k]));
  if (bad.length) { fail++; console.log('FAIL', name, bad.map(k => `${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(exp[k])}`).join(' | ')); }
  else console.log('ok  ', name);
}
(async () => {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt-ar-en.pdf')));
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(R.pageTextFromItems((await (await doc.getPage(i)).getTextContent()).items));
    check('page 1 vendor line is joined arabic', { line: pages[0].split('\n')[0] }, { line: 'مؤسسة النور للمواد الكهربائية' });
    check('page 1 has no letter-by-letter spacing', { spaced: /(?:^|\s)[\u0621-\u064A](?:\s[\u0621-\u064A]){3,}(?:\s|$)/.test(pages[0]) }, { spaced: false });
    check('pages pass text quality (no OCR needed)', { q: pages.map(p => R.pageTextQuality(p).needOcr) }, { q: [false, false] });
    const recs = R.splitReceiptText(pages).map(s => R.extractReceiptFields(s.text));
    check('two receipts split', { n: recs.length }, { n: 2 });
    check('arabic receipt fields', recs[0] || {}, { vendor: 'مؤسسة النور للمواد الكهربائية', date: '2026-10-12', no: 'INV-10234', amount: 488.75, vat: 63.75, supplierNo: '300123456700003', checked: true });
    check('english receipt fields', recs[1] || {}, { vendor: 'ACE HARDWARE STORE', date: '2026-10-03', no: '778812', amount: 94.88, vat: 12.38 });
  } catch (e) { fail++; console.log('FAIL exception', e.message); }
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})();
