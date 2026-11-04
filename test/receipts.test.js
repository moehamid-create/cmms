const R = require('../receipts.js');
let fail = 0;
function check(name, got, exp) {
  const bad = Object.keys(exp).filter(k => JSON.stringify(got[k]) !== JSON.stringify(exp[k]));
  if (bad.length) { fail++; console.log('FAIL', name, bad.map(k => `${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(exp[k])}`).join(' | ')); }
  else console.log('ok  ', name);
}
const F = R.extractReceiptFields;

/* 1. OCR نظيف (ناتج Tesseract حقيقي — مع علامات الاتجاه الخفية) */
const ocrClean = "مؤسسة النور للمواد الكهربائية\n\nفرع الرياض - حي العليا\n\nالرقم الضريبي: 300123456700003\nفاتورة ضريبية مبسطة\n\nرقم الفاتورة: \u200EINV-10234\u200F\n\nالتاريخ: 2026/10/12 10:45\nالصنف الكمية السعر\n\nكيبل 2.5 مم 2 150.00\n\u200Elia\u200F إثازة 5 2500\nالإجمالي قبل \u200EAyal\u200F 425.00\nضريبة القيمة المضافة 9615: 63.75\n\u200EJay!\u200F شامل \u200Eay all\u200F 488.75\nشكرا لزيارتكم\n";
check('ocr clean', F(ocrClean), { vendor: 'مؤسسة النور للمواد الكهربائية', date: '2026-10-12', no: 'INV-10234', amount: 488.75, vat: 63.75, supplierNo: '300123456700003', currency: 'SAR' });

/* 2. OCR مشوّش (ناتج Tesseract حقيقي لصورة ممسوحة) — الفواصل العشرية ضائعة */
const ocrNoisy = "fr hala hang, ٠\n1 \u200Fفرع الرياض - حي العليا\u200E\n300123456700003 \u200Fالرقم الضريبي:\u200E '\n\u200Fقاتورة ضريبية مبسطة\u200E :\n= : INV-10234 \u200Fرقم القاتورة:\u200E\n1 10:45 2026/10/12 \u200Fالتاريخ:\u200E\n\u200E| 190.00 2: ezSg&\n: B08 hgh\nte rr \u200Fو\u200E\n\u200E{ies 42500 \u200Fالإجمالي قبل الضربية:\u200E >:\n5 0375 MERA \u200Fخربية\u200E\n\u200Eah 48875 \u200Fالضربية:\u200E As \u200Fالإجمالي\u200E\n\u200EHah MAS \u200Fفقا\u200E E+\n";
check('ocr noisy', F(ocrNoisy), { date: '2026-10-12', no: 'INV-10234', amount: 488.75, vat: 63.75, supplierNo: '300123456700003' });

/* 3. PDF نصي (أسطر مُعاد بناؤها RTL — القيمة قبل التسمية) */
const pdfText = ["شركة الأفق للتجارة","فاتورة ضريبية","INV-2026-0042 : رقم الفاتورة","15/09/2026 : التاريخ","310987654300003 : الرقم الضريبي","1,200.00 : المجموع الفرعي","180.00 : ضريبة القيمة المضافة (15%)","1,380.00 : الإجمالي شامل الضريبة","شكراً لتعاملكم معنا"].join('\n');
check('pdf text rtl', F(pdfText), { vendor: 'شركة الأفق للتجارة', date: '2026-09-15', no: 'INV-2026-0042', amount: 1380, vat: 180, supplierNo: '310987654300003', currency: 'SAR' });

/* 4. إيصال إنجليزي */
const en = ["ACE HARDWARE STORE","123 King Fahd Rd","Tel: 011 456 7890","Receipt No: 778812","Date: Oct 3, 2026  14:22","Hammer 1 45.00","Nails 3 12.50","Subtotal 82.50","VAT 15% 12.38","TOTAL SAR 94.88","Cash 100.00","Change 5.12","Thank you!"].join('\n');
check('english', F(en), { vendor: 'ACE HARDWARE STORE', date: '2026-10-03', no: '778812', amount: 94.88, vat: 12.38, currency: 'SAR' });

/* 5. خصم ثم الإجمالي بعد الخصم */
const disc = ["سوبر ماركت الريان","التاريخ 2026-08-01","الإجمالي 500.00","خصم 50.00","الإجمالي بعد الخصم 450.00","ضريبة القيمة المضافة 58.70","المبلغ المستحق 450.00"].join('\n');
check('discount', F(disc), { vendor: 'سوبر ماركت الريان', amount: 450, vat: 58.7 });

/* 6. فاصلة عشرية بالفاصلة الأوروبية وتاريخ مع شهر عربي */
const eu = ["مطعم البيك","12 أكتوبر 2026","الإجمالي: 1.234,50 ريال"].join('\n');
check('eu+arabic month', F(eu), { vendor: 'مطعم البيك', date: '2026-10-12', amount: 1234.5, currency: 'SAR' });

/* 7. أرقام عربية-هندية */
const ind = ["محلات الصفا","التاريخ: ٢٠٢٦/٠٧/٠٥","الإجمالي شامل الضريبة: ١١٥٫٠٠","ضريبة القيمة المضافة: ١٥٫٠٠"].join('\n');
check('arabic-indic digits', F(ind), { vendor: 'محلات الصفا', date: '2026-07-05', amount: 115, vat: 15 });

/* 8. تقسيم صفحة بها إيصالان */
const two = [ocrClean.replace(/\n+/g, '\n'), pdfText].join('\n');
const segs = R.splitReceiptText([two]);
check('split 2 on page', { n: segs.length, a: segs.map(s => F(s.text).amount) }, { n: 2, a: [488.75, 1380] });

/* 9. صفحة ممسوحة بلا نص / طبقة OCR رديئة / نص صالح */
check('quality empty', R.pageTextQuality('  \n '), { needOcr: true });
check('quality junk layer', R.pageTextQuality('fr hala hang ezSg& hgh te rr Hah MAS ies ah'), { needOcr: true });
check('quality pua', R.pageTextQuality('\uE001\uE002\uE003\uE004 \uE005\uE006 total 12.00 \uE007\uE008\uE009\uE00A\uE00B\uE00C'), { needOcr: true });
check('quality good', R.pageTextQuality(pdfText), { needOcr: false });

/* 10. نوع الملف من البايتات */
check('sniff', { pdf: R.sniffMime(Buffer.from('%PDF-1.7 xxxxxxxx')), jpg: R.sniffMime(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0])), heic: R.sniffMime(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0', 'latin1')) },
  { pdf: 'application/pdf', jpg: 'image/jpeg', heic: 'image/heic' });

/* 11. تاريخ غير صالح ورقم ضريبي بمسافات */
const sp = ["مؤسسة الجود","الرقم الضريبي 300 1234 5670 0003","التاريخ 31/02/2026 و 2026/03/01","الإجمالي 230.00","الضريبة 30.00"].join('\n');
check('spaced vat no / invalid date', F(sp), { supplierNo: '300123456700003', date: '2026-03-01', amount: 230, vat: 30 });

/* 12. OCR حقيقي لصورة مظللة: "15%" تُقرأ 9615 ملتصقة بالمبلغ، وسطر لاتيني قصير ليس مورّداً */
const shaded = "فرع الرياض - حيالعليا\n300123456700003 eal 3\n‏مبسطة‎ dy yn js\nرقم الفاتورة:‎INV-10234‏\nالتاريخ: 2026/10/1210:45\nالصثف   الكمية‎aad‏\nكيبل 2.5        مم 2150.00\nمفتاح      إنارة     525.00\nاااي\nالإجمالي قل الضريية: |425.00\n‎wn‏ القيمة المضافة 9615:63.75\n’الإجمالي يرامل الضريبة:488.75\nو شكرالزيارتكم";
check('shaded photo ocr', F(shaded), { date: '2026-10-12', no: 'INV-10234', amount: 488.75, vat: 63.75, vendor: undefined });

/* 13. وقت حقيقي لا يُخلط بالمبالغ */
check('time vs money', F("مطعم الشرق\nالتاريخ 2026-05-02 12:45\nالإجمالي 57.50"), { amount: 57.5, date: '2026-05-02' });

/* 14. تسمية رقم الفاتورة مشوّهة أو مفقودة */
check('garbled no label', F("مؤسسة النور\nرقم القتررة:‎INV-10234‏\nالإجمالي 10.00"), { no: 'INV-10234' });
check('bare invoice code', F("مؤسسة النور\nINV-10234 5,00 4;\nالإجمالي 10.00"), { no: 'INV-10234' });
check('vat no is not receipt no', F("مؤسسة النور\nرقم ضريبي 300123456700003\nالإجمالي 10.00"), { no: undefined });

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
