/* اختبار تكاملي للحفظ التفاضلي: نأخذ دالة buildPatch من الواجهة نفسها (public/index.html)،
   نعدّل الحالة محلياً، نرسل الفرق فقط، ثم نتأكد أن ما خزّنه الخادم يطابق النسخة المحلية حرفياً.
   يشغّل الخادم على قاعدة بيانات مؤقتة ومنفذ عشوائي، ولا يلمس cmms.db الحقيقية. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---- نسخ كود الحفظ التفاضلي من الواجهة كما هو ---- */
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const startAt = html.indexOf('const SAVE_REC_KEYS=');
const endMark = 'return {patch,snap,empty:n===0};\n}';
const endAt = html.indexOf(endMark, startAt);
if (startAt < 0 || endAt < 0) throw new Error('patch code not found in public/index.html');
const clientSrc = html.slice(startAt, endAt + endMark.length);
const client = new Function('SAVE', clientSrc + '\nreturn {snapState, setSaveBase, buildPatch};');
const SAVE = {};
const { setSaveBase, buildPatch } = client(SAVE);

const PORT = 4300 + Math.floor(Math.random() * 400);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cmms-patch-'));
let fail = 0;
function ok(name, cond, extra) { if (cond) console.log('ok  ', name); else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); } }

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, DATABASE_URL: '',
    PM_SCHEDULER: 'off', NODE_ENV: 'test' }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
srv.stdout.on('data', d => { log += d; });
srv.stderr.on('data', d => { log += d; });

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start:\n' + log);
}
async function login(u) {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u, p: '1234' }) });
  if (r.status !== 200) throw new Error('login ' + u + ' -> ' + r.status);
  const j = await r.json();
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j.csrf };
}
async function getState(s) {
  return (await fetch(BASE + '/api/state', { headers: { cookie: s.cookie } })).json();
}
async function post(s, body) {
  const txt = JSON.stringify(body);
  const r = await fetch(BASE + '/api/state', { method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf }, body: txt });
  return { status: r.status, body: await r.json().catch(() => ({})), bytes: txt.length };
}
/* يحاكي queueSave: لقطة من نسخة الخادم ← تعديل محلي ← إرسال الفرق */
async function patchSave(s, st, local) {
  setSaveBase(st.data, st.ver);
  const d = buildPatch(local, SAVE.base);
  if (d.empty) return { status: 'empty', patch: d.patch };
  const r = await post(s, { baseVer: st.ver, patch: d.patch });
  r.patch = d.patch;
  return r;
}
const clone = o => JSON.parse(JSON.stringify(o));
/* المقارنة تتجاهل users (الخادم يحذف كلمات المرور عند القراءة) */
function diffKeys(a, b) {
  const out = [];
  for (const k of new Set(Object.keys(a).concat(Object.keys(b)))) {
    if (k === 'users') continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

(async () => {
  try {
    await waitUp();
    const admin = await login('admin');
    const tech = await login('sami');

    /* 0. كود الواجهة: لا تغيير = لا طلب */
    let st = await getState(admin);
    let r = await patchSave(admin, st, clone(st.data));
    ok('no change produces an empty patch (no request)', r.status === 'empty', r);

    /* 1. المدير: تعديلات متنوعة تصل كاملة وبحجم أصغر بكثير من الحالة */
    let local = clone(st.data);
    const C = local.compounds[0].id;
    local.wos.unshift({ no: 'WO-P-1', title: 'leak', status: 'open', compoundId: C });   /* جديد في البداية، مفتاحه no */
    local.buildings[3].name = 'فيلا معدّلة';                                                  /* تعديل سجل */
    const delId = local.buildings[5].id;
    local.buildings.splice(5, 1);                                                             /* حذف سجل */
    local.inv.push({ id: 'INV-P-1', name: 'filter', qty: 4, compoundId: C });                 /* جديد في النهاية */
    local.categories.push('فئة جديدة');                                                       /* مصفوفة نصوص بلا معرّف */
    local.seq = (local.seq || 0) + 1;                                                         /* قيمة بسيطة */
    local.patchProbe = { on: true };                                                          /* مفتاح جديد */
    r = await patchSave(admin, st, local);
    ok('admin patch accepted', r.status === 200, r);
    const full = JSON.stringify({ baseVer: st.ver, data: local }).length;
    ok('patch body is much smaller than the full state', r.bytes * 5 < full, { patch: r.bytes, full });
    ok('patch carries only changed buildings', r.patch.coll && r.patch.coll.buildings && r.patch.coll.buildings.up.length === 1
      && r.patch.coll.buildings.del[0] === delId && !r.patch.coll.buildings.order, r.patch.coll && r.patch.coll.buildings);
    ok('work orders keyed by no, new one sent as head', r.patch.coll && r.patch.coll.wos && r.patch.coll.wos.key === 'no'
      && r.patch.coll.wos.head && r.patch.coll.wos.head[0] === 'WO-P-1', r.patch.coll && r.patch.coll.wos);
    let after = await getState(admin);
    ok('server state matches the local copy exactly', diffKeys(after.data, local).length === 0, diffKeys(after.data, local));
    ok('version advanced by one', after.ver === st.ver + 1, { before: st.ver, after: after.ver });

    /* 2. إعادة ترتيب + حذف مفتاح + حذف آخر سجل */
    st = after; local = clone(st.data);
    local.buildings.reverse();
    delete local.patchProbe;
    local.inv = local.inv.filter(i => i.id !== 'INV-P-1');
    r = await patchSave(admin, st, local);
    ok('reorder/unset patch accepted', r.status === 200, r);
    ok('reorder sends an id order, not the records', r.patch.coll.buildings.order && !r.patch.coll.buildings.up, r.patch.coll.buildings);
    after = await getState(admin);
    ok('reorder, unset and delete applied exactly', diffKeys(after.data, local).length === 0, diffKeys(after.data, local));

    /* 3. معرّفات مكررة → المصفوفة كاملة (set) وتبقى صحيحة */
    st = after; local = clone(st.data);
    local.inv.push({ id: 'DUP', name: 'a' }, { id: 'DUP', name: 'b' });
    r = await patchSave(admin, st, local);
    ok('duplicate ids fall back to sending the whole array', r.status === 200 && r.patch.set && Array.isArray(r.patch.set.inv), r.patch);
    after = await getState(admin);
    ok('duplicate-id array stored exactly', diffKeys(after.data, local).length === 0, diffKeys(after.data, local));

    /* 4. نسخة قديمة → 409 كما في الحفظ الكامل */
    local = clone(after.data); local.seq++;
    setSaveBase(st.data, st.ver);
    r = await post(admin, { baseVer: st.ver, patch: buildPatch(local, SAVE.base).patch });
    ok('stale baseVer is rejected with 409', r.status === 409, r);

    /* 5. رقعة غير صالحة → 400 BAD_PATCH ولا تغيير */
    st = after;
    for (const bad of [{ coll: { wos: { key: 'name', up: [] } } }, { coll: { inv: { key: 'id', up: [{ name: 'no id' }] } } },
      JSON.parse('{"set":{"__proto__":{"x":1}}}'), { set: [] }]) {
      r = await post(admin, { baseVer: st.ver, patch: bad });
      ok('bad patch rejected: ' + JSON.stringify(bad).slice(0, 50), r.status === 400 && r.body.error === 'BAD_PATCH', r);
    }
    after = await getState(admin);
    ok('bad patches did not change the version', after.ver === st.ver, { before: st.ver, after: after.ver });

    /* 6. الفني: الصلاحيات نفسها تنطبق على الحفظ التفاضلي */
    st = await getState(tech); local = clone(st.data);
    local.wos.unshift({ no: 'WO-P-TECH', title: 'tech', status: 'open', compoundId: C });
    local.contracts.push({ id: 'CX-P', vendor: 'evil' });
    r = await patchSave(tech, st, local);
    ok('tech patch accepted with contracts dropped', r.status === 200 && (r.body.dropped || []).includes('contracts'), r.body);
    after = await getState(admin);
    ok('tech: work order saved', after.data.wos.some(w => w.no === 'WO-P-TECH'));
    ok('tech: contracts change NOT saved', !after.data.contracts.some(c => c.id === 'CX-P'));

    st = await getState(tech); local = clone(st.data);
    local.users.find(u => u.u === 'sami').role = 'admin';
    r = await patchSave(tech, st, local);
    ok('tech cannot change users through a patch', r.status === 403 && r.body.error === 'USERS_FORBIDDEN', r);

    /* 7. المدير يعدّل مستخدماً عبر الرقعة: كلمة المرور المشفّرة تبقى صالحة */
    st = await getState(admin); local = clone(st.data);
    const sami = local.users.find(u => u.u === 'sami');
    sami.name = 'سامي (معدّل)';
    r = await patchSave(admin, st, local);
    ok('admin user edit via patch accepted', r.status === 200 && r.patch.coll && r.patch.coll.users && r.patch.coll.users.up.length === 1, r);
    const relog = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: 'sami', p: '1234' }) });
    ok('edited user can still log in (password hash kept)', relog.status === 200, relog.status);

    /* 8. الحفظ الكامل القديم ما زال يعمل */
    st = await getState(admin); local = clone(st.data); local.seq++;
    r = await post(admin, { baseVer: st.ver, data: local });
    ok('legacy full save still accepted', r.status === 200, r);
  } catch (e) {
    fail++; console.log('FAIL exception', e.stack || e.message);
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} }, 300);
    console.log(fail ? `\n${fail} failing` : '\nall passed');
    process.exitCode = fail ? 1 : 0;
  }
})();
