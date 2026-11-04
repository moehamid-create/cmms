/* تحسين صور الإيصالات قبل القراءة الضوئية — يعمل داخل Web Worker (لا يجمّد الواجهة)،
   ويمكن تحميله في الصفحة نفسها كبديل إن تعذّر إنشاء Worker.
   المدخل: بكسلات RGBA. المخرج: تدرّج رمادي بإضاءة موحّدة وتباين مشدود (حبر أسود، خلفية بيضاء)
   + تقدير ارتفاع سطر النص (لإعادة التحجيم إلى الحجم الأمثل لـ Tesseract). */
'use strict';
function rcptPrepPixels(px, w, h, clip) {
  const n = w * h, gray = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;

  /* الخلفية: متوسط كتل f×f ثم أقصى قيمة في جوار 5×5 كتل (يتجاهل الحبر الداكن) */
  const f = Math.max(8, Math.round(Math.min(w, h) / 50)), sw = Math.ceil(w / f), sh = Math.ceil(h / f), NB = sw * sh;
  const sum = new Float64Array(NB), cnt = new Uint32Array(NB);
  for (let y = 0; y < h; y++) {
    const rb = ((y / f) | 0) * sw, row = y * w;
    for (let bx = 0; bx < sw; bx++) {
      const x0 = bx * f, x1 = Math.min(w, x0 + f);
      let s = 0;
      for (let x = x0; x < x1; x++) s += gray[row + x];
      sum[rb + bx] += s; cnt[rb + bx] += x1 - x0;
    }
  }
  const sm = new Float32Array(NB);
  for (let i = 0; i < NB; i++) sm[i] = cnt[i] ? sum[i] / cnt[i] : 255;
  const R = 2, bg = new Float32Array(NB);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let m = 1;
    for (let yy = Math.max(0, y - R); yy <= Math.min(sh - 1, y + R); yy++) {
      const r = yy * sw;
      for (let xx = Math.max(0, x - R); xx <= Math.min(sw - 1, x + R); xx++) { const v = sm[r + xx]; if (v > m) m = v; }
    }
    bg[y * sw + x] = m;
  }

  /* القسمة على الخلفية (استيفاء ثنائي منفصل: جداول مسبقة للأعمدة، وصف واحد لكل سطر) + المدرج التكراري */
  const X0 = new Int32Array(w), X1 = new Int32Array(w), TX = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(sw - 1, Math.max(0, x / f - 0.5)), x0 = Math.min(sw - 1, fx | 0);
    X0[x] = x0; X1[x] = Math.min(sw - 1, x0 + 1); TX[x] = fx - x0;
  }
  const inv = new Float32Array(w), norm = new Uint8Array(n), hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, y / f - 0.5)), y0 = Math.min(sh - 1, fy | 0), ty = fy - y0;
    const r0 = y0 * sw, r1 = Math.min(sh - 1, y0 + 1) * sw;
    for (let x = 0; x < w; x++) {
      const a = X0[x], b = X1[x], t = TX[x];
      const v = (bg[r0 + a] * (1 - t) + bg[r0 + b] * t) * (1 - ty) + (bg[r1 + a] * (1 - t) + bg[r1 + b] * t) * ty;
      inv[x] = 255 / v;
    }
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = gray[row + x] * inv[x]; v = v > 255 ? 255 : v;
      const q = v | 0; norm[row + x] = q; hist[q]++;
    }
  }

  /* شدّ التباين بجدول: الخلفية بيضاء والحبر أسود، والنقاط الفاتحة (حبيبات) تُقصّ إلى أبيض */
  const pct = p => { let s = 0; const t = n * p; for (let i = 0; i < 256; i++) { s += hist[i]; if (s >= t) return i; } return 255; };
  const lo = pct(0.005), hi = Math.max(lo + 30, pct(0.5) * 0.96), sc = 255 / (hi - lo), cl = clip == null ? 200 : clip;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { let v = (i - lo) * sc; v = v < 0 ? 0 : v >= cl ? 255 : v; lut[i] = v; }

  /* المخرج + المسقط الأفقي في 8 شرائح عمودية (لتقدير ارتفاع السطر رغم الميلان) */
  const out = new Uint8ClampedArray(n * 4), SN = 8, stw = Math.ceil(w / SN), dark = new Uint32Array(h * SN);
  for (let y = 0, i = 0, j = 0; y < h; y++) {
    const dr = y * SN;
    for (let x = 0; x < w; x++, i++, j += 4) {
      const v = lut[norm[i]];
      out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255;
      if (v < 110) dark[dr + ((x / stw) | 0)]++;
    }
  }
  const minInk = Math.max(2, stw * 0.02), runs = [];
  for (let s = 0; s < SN; s++) {
    let st = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && dark[y * SN + s] >= minInk;
      if (on && st < 0) st = y;
      else if (!on && st >= 0) { const L = y - st; if (L >= 5 && L < h / 4) runs.push(L); st = -1; }
    }
  }
  let lineH = 0;
  if (runs.length >= 6) { runs.sort((p, q) => p - q); lineH = runs[runs.length >> 1]; }
  return { out, lineH };
}
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = e => {
    const d = e.data || {};
    try {
      const r = rcptPrepPixels(new Uint8ClampedArray(d.buf), d.w, d.h, d.clip);
      self.postMessage({ id: d.id, buf: r.out.buffer, lineH: r.lineH }, [r.out.buffer]);
    } catch (err) { self.postMessage({ id: d.id, error: String(err && err.message || err) }); }
  };
}
