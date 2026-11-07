/* اختبار تكاملي: حارس صلاحيات الكتابة على POST /api/state + الصيانة الدورية بالعدّاد في مُجدوِل الخادم.
   يشغّل الخادم على قاعدة بيانات مؤقتة ومنفذ عشوائي، ولا يلمس cmms.db الحقيقية. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 400);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cmms-guard-'));
let fail = 0;
function ok(name, cond, extra) { if (cond) console.log('ok  ', name); else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } }

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, DATABASE_URL: '',
    PM_SCHEDULER: 'on', PM_APPROVAL: 'off', NODE_ENV: 'test' }),
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
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { cookie, csrf: j.csrf };
}
async function getState(s) {
  const r = await fetch(BASE + '/api/state', { headers: { cookie: s.cookie } });
  return r.json();
}
async function save(s, ver, data) {
  const r = await fetch(BASE + '/api/state', { method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf },
    body: JSON.stringify({ baseVer: ver, data }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function runPm(s) {
  const r = await fetch(BASE + '/api/pm/run', { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
  return r.json();
}

(async () => {
  try {
    await waitUp();
    const admin = await login('admin');
    const tech = await login('sami');
    const store = await login('store');

    /* 1. الفني: تعديل أوامر العمل يُحفظ، وتعديل العقود يُستبعد */
    let st = await getState(tech);
    ok('new arrays exist (readings, downtime)', Array.isArray(st.data.readings) && Array.isArray(st.data.downtime));
    const d1 = st.data;
    d1.wos.unshift({ no: 'WO-T-1', title: 'tech wo', status: 'open', compoundId: d1.compounds[0].id });
    d1.contracts.push({ id: 'CX1', no: 'CT-X', vendor: 'evil' });
    d1.readings.unshift({ id: 'RD1', assetId: 'A1', value: 10, at: Date.now() });
    let r = await save(tech, st.ver, d1);
    ok('tech save accepted', r.status === 200, r);
    ok('tech: contracts reported as dropped', Array.isArray(r.body.dropped) && r.body.dropped.includes('contracts'), r.body);
    st = await getState(admin);
    ok('tech: wos change persisted', st.data.wos.some(w => w.no === 'WO-T-1'));
    ok('tech: readings change persisted', st.data.readings.some(x => x.id === 'RD1'));
    ok('tech: contracts change NOT persisted', !st.data.contracts.some(c => c.id === 'CX1'));
    ok('rbac_drop audit entry written', st.data.audit.some(a => a.action === 'rbac_drop' && a.ref.includes('contracts')));

    /* 2. أمين المخزون لا يعدّل أوامر العمل ولا الموظفين */
    st = await getState(store);
    const d2 = st.data;
    d2.wos = [];
    d2.employees.push({ id: 'EX1', name: 'x' });
    d2.inv.push({ id: 'IX1', name: 'filter', qty: 3, minQty: 1, compoundId: d2.compounds[0].id });
    r = await save(store, st.ver, d2);
    ok('store save accepted', r.status === 200, r);
    ok('store: wos and employees dropped', r.body.dropped && r.body.dropped.includes('wos') && r.body.dropped.includes('employees'), r.body);
    st = await getState(admin);
    ok('store: wos not wiped', st.data.wos.some(w => w.no === 'WO-T-1'));
    ok('store: inv change persisted', st.data.inv.some(i => i.id === 'IX1'));

    /* 3. المدير: كل شيء مسموح ولا يوجد dropped */
    const d3 = st.data;
    d3.contracts.push({ id: 'CA1', no: 'CT-A', vendor: 'ok' });
    r = await save(admin, st.ver, d3);
    ok('admin save accepted without drops', r.status === 200 && !r.body.dropped, r);
    st = await getState(admin);
    ok('admin: contracts persisted', st.data.contracts.some(c => c.id === 'CA1'));

    /* 4. مُجدوِل الخادم: خطة «كل 500 وحدة عداد» تستحق عند تجاوز العداد، ولا تستحق قبله */
    const d4 = st.data;
    const C = d4.compounds[0].id;
    const far = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
    d4.assets.push({ id: 'AM1', name: 'Generator', compoundId: C, meter: 1000, meterUnit: 'ساعة', status: 'ok' });
    d4.assets.push({ id: 'AM2', name: 'Pump', compoundId: C, meter: 1000, meterUnit: 'ساعة', status: 'ok' });
    d4.pms.push({ id: 'PM1', name: 'Gen 500h', assetId: 'AM1', compoundId: C, freqVal: 12, freqUnit: 'months', nextDue: far, leadDays: 0, mEvery: 500, lastMeter: 400, tasks: 'ضغط الزيت [رقم 2-5 بار]\nتسريب وقود [حرج]' });
    d4.pms.push({ id: 'PM2', name: 'Pump 500h', assetId: 'AM2', compoundId: C, freqVal: 12, freqUnit: 'months', nextDue: far, leadDays: 0, mEvery: 500, lastMeter: 900 });
    r = await save(admin, st.ver, d4);
    ok('admin seeded meter PMs', r.status === 200, r);
    const pm = await runPm(admin);
    ok('scheduler created exactly one WO', pm.created === 1, pm);
    st = await getState(admin);
    const w1 = st.data.wos.find(w => w.pmId === 'PM1');
    ok('meter-due plan generated a WO flagged meterTrigger', w1 && w1.meterTrigger === true && w1.meterAt === 1000, w1);
    ok('not-yet-due meter plan did not generate', !st.data.wos.some(w => w.pmId === 'PM2'));
    const ck = (w1 && w1.checklist) || [];
    ok('scheduler builds typed checklist items', ck.length === 2 && ck[0].type === 'number' && ck[0].min === 2 && ck[0].max === 5
      && ck[0].unit === 'بار' && ck[0].t === 'ضغط الزيت' && ck[1].crit === true && ck[1].type === 'check', ck);

    /* 5. مؤشرات الحالة: أمر واحد للقراءة خارج الحد، ولا تكرار مع أمر مفتوح، ولا أمر لقراءة سبقت إصلاحاً مغلقاً */
    const d5 = st.data, now = Date.now();
    d5.assets.push({ id: 'AG1', name: 'Fire pump', compoundId: C, status: 'ok', gauges: [
      { id: 'G-LOW', name: 'Pressure', unit: 'بار', min: 6, max: 10, priority: 'urgent', value: 4.5, at: now },
      { id: 'G-OK', name: 'Temp', unit: '°م', max: 60, value: 40, at: now },
      { id: 'G-OPEN', name: 'Vibration', unit: 'مم/ث', max: 7, value: 9, at: now },
      { id: 'G-FIXED', name: 'Voltage', unit: 'فولت', min: 210, value: 190, at: now - 3600e3 }
    ] });
    d5.wos.unshift({ no: 'WO-G-OPEN', gaugeId: 'G-OPEN', status: 'open', compoundId: C, title: 'vib' });
    d5.wos.unshift({ no: 'WO-G-FIXED', gaugeId: 'G-FIXED', status: 'closed', closedAt: now - 60e3, compoundId: C, title: 'volt' });
    r = await save(admin, st.ver, d5);
    ok('admin seeded gauges', r.status === 200, r);
    const g = await runPm(admin);
    ok('gauge check created exactly one WO', g.created === 1, g);
    st = await getState(admin);
    const gw = st.data.wos.filter(w => w.source === 'gauge');
    ok('low reading opened an urgent WO with value and limit', gw.length === 1 && gw[0].gaugeId === 'G-LOW' && gw[0].priority === 'urgent'
      && gw[0].gaugeValue === 4.5 && gw[0].gaugeLimit === 6 && gw[0].gaugeSide === 'low', gw);
    ok('gauge WO raised a notification', st.data.notifs.some(n => String(n.key).startsWith('gauge:G-LOW:')));
    const again = await runPm(admin);
    ok('second run does not duplicate the gauge WO', again.created === 0, again);
  } catch (e) {
    fail++; console.log('FAIL exception', e.message);
  } finally {
    srv.kill();
    setTimeout(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} }, 300);
    console.log(fail ? `\n${fail} failing` : '\nall passed');
    process.exitCode = fail ? 1 : 0;
  }
})();
