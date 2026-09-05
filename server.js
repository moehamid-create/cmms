/* ============================================
   CMMS Web Server — Express + SQLite / Postgres
   - Local / disk: built-in node:sqlite (no deps)
   - Cloud (free): Postgres via DATABASE_URL (Neon/Supabase),
     keeps data forever on Render's free plan (no disk needed)
   ============================================ */
const express  = require('express');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const USE_PG = !!process.env.DATABASE_URL;
let sqlite = null, pgPool = null, DB_LABEL = '';

if (USE_PG) {
  /* ---- Cloud Postgres (Neon / Supabase — free tier) ---- */
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },   /* required by Neon/Supabase */
    max: 5,
  });
  pgPool.on('error', (e) => console.error('PG pool error:', e.message));
  DB_LABEL = 'postgres';
} else {
  /* ---- Local SQLite file (DATA_DIR=/data on a persistent disk) ---- */
  const { DatabaseSync } = require('node:sqlite');
  const DATA_DIR = process.env.DATA_DIR || __dirname;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  const DB_PATH = path.join(DATA_DIR, 'cmms.db');
  sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec(`CREATE TABLE IF NOT EXISTS appstate(
    id      INTEGER PRIMARY KEY CHECK(id=1),
    data    TEXT NOT NULL,
    ver     INTEGER NOT NULL DEFAULT 1,
    updated TEXT
  )`);
  DB_LABEL = 'sqlite:' + DB_PATH;
}

/* Ensure the Postgres table exists (runs once at startup) */
async function pgInit() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS appstate(
    id      INTEGER PRIMARY KEY CHECK(id=1),
    data    TEXT NOT NULL,
    ver     INTEGER NOT NULL DEFAULT 1,
    updated TIMESTAMPTZ DEFAULT now()
  )`);
}

const app = express();
app.set('trust proxy', 1);
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
const sessionCookie = process.env.SESSION_COOKIE || 'cmms_session';
const sessionSecret = process.env.SESSION_SECRET || (!isProduction ? 'local-development-only-change-me' : '');
if (isProduction && (!sessionSecret || sessionSecret.length < 32)) {
  console.error('SESSION_SECRET must be set to at least 32 characters in production');
  process.exit(1);
}

/* ---- Baseline browser security; same-origin by default ---- */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://api.qrserver.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'",
  });
  if (isProduction && req.secure) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.has(origin) || origin === `${req.protocol}://${req.get('host')}`)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(origin && !allowedOrigins.has(origin) && origin !== `${req.protocol}://${req.get('host')}` ? 403 : 204);
  next();
});
app.use(express.json({ limit: '40mb', strict: true }));   /* الصور تُحفظ داخل البيانات — حد كبير لصور قبل/بعد */
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  /* الصور والملفات تُحفَظ مؤقتاً، لكن صفحة HTML دائماً طازجة (عشان التحديثات تظهر فوراً) */
  setHeaders: (res, fp) => { if (String(fp).endsWith('index.html')) res.setHeader('Cache-Control', 'no-store'); },
}));

/* ---- Health check (no auth — for Render/Fly/UpTimeRobot) ---- */
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/api/health', (req, res) => res.json({ ok: true, db: DB_LABEL, time: new Date().toISOString() }));

/* ---- Simple login rate-limit: 20 attempts / 10 min per IP ---- */
const loginHits = new Map();
function boundedHit(map, key, windowMs, max) {
  const now = Date.now();
  const arr = (map.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  if (map.size > 5000) for (const [k, values] of map) if (!values.some(t => now - t < windowMs)) map.delete(k);
  map.set(key, arr);
  return arr.length <= max;
}
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'x';
  if (!boundedHit(loginHits, ip, 10 * 60 * 1000, 10)) return res.status(429).json({ error: 'TOO_MANY' });
  next();
}

/* ---- Public portal rate-limit: 15 requests / hour per IP ---- */
const pubHits = new Map();
function pubLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'x';
  if (!boundedHit(pubHits, ip, 60 * 60 * 1000, 15)) return res.status(429).json({ error: 'TOO_MANY' });
  next();
}
/* Serialize state writes from the public portal (avoid lost updates) */
let writeLock = Promise.resolve();
function serialized(fn) {
  const run = writeLock.then(fn, fn);
  writeLock = run.catch(() => {});
  return run;
}
function normPhone(s) { return String(s || '').replace(/\D/g, ''); }

const sessions = new Map();                           /* رموز الجلسات */
const SESSION_TTL = 1000 * 60 * 60 * 12;              /* 12 ساعة */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.at > SESSION_TTL) sessions.delete(k);
}, 15 * 60 * 1000).unref();

/* ---- التهيئة الأولى: حالة ابتدائية مطابقة لنسخة المتصفح ---- */
function seedState(){
  const rid=p=>p+crypto.randomBytes(5).toString('hex');
  const C=rid('C');
  const U=o=>Object.assign({id:rid('U'),phone:'',email:'',cmpIds:null,activeCmp:''},o);
  const d={
    lang:'ar',ver:6,seq:0,prSeq:0,poSeq:0,rnSeq:0,prjSeq:0,ctSeq:0,seeded:false,
    users:[
      U({u:'admin',  p:'1234',name:'مدير النظام',   role:'admin'})
    ],
    categories:['تكييف سبليت','تكييف مركزي / دكت','سخان مياه','مضخة مياه',
     'مضخة / فلتر مسبح','نظام معالجة مياه','جاكوزي / سبا','أجهزة الجيم','لوحة كهرباء','إنارة داخلية',
     'إنارة خارجية','مولد احتياطي','بوابة أوتوماتيكية','مصعد','نظام إنذار حريق','كاشف دخان',
     'طفاية حريق','شبكة إطفاء / رشاشات','سباكة وصنابير','أخرى'],
    compounds:[{id:C,name:'مجمع الخير السكني - حي الروضة',loc:'',notes:'',createdAt:Date.now()}],
    buildings:[],units:[],tenants:[],contracts:[],assets:[],wos:[],inv:[],moves:[],
    pms:[],suppliers:[],prs:[],pos:[],projects:[],employees:[],shifts:[],notifs:[]
  };
  const addB=(name,type,floors)=>d.buildings.push({id:rid('B'),name,type,floors:floors.slice(),compoundId:C});
  for(let i=1;i<=34;i++)addB('فيلا '+i,'villa',['الدور الأرضي','الدور الأول','الملحق']);
  addB('المسبح','area',['حمام السباحة','غرفة الفلاتر والمعدات']);
  addB('ملعب الأطفال','area',['ساحة اللعب']);
  addB('نادي الجيم','area',['صالة الأجهزة','صالة الأوزان']);
  addB('منطقة السبا','area',['غرفة الساونا','غرفة التدليك','غرفة البخار']);
  addB('الباركنج','area',['المستوى الأرضي','الطابق السفلي']);
  addB('اللوبي والمداخل','area',['الاستقبال','الطرقات الداخلية']);
  addB('غرف الخدمات','area',['غرفة الكهرباء الرئيسية','غرفة المضخات','غرفة الحراسة']);
  addB('المرافق الخارجية','area',['الأسوار والبوابات','الإنارة الخارجية','الحدائق والري']);
  return d;
}

/* ---- Storage access: same API on SQLite and Postgres ---- */
async function pgGet() {
  const r = await pgPool.query('SELECT data, ver FROM appstate WHERE id=1');
  return r.rows[0] || null;
}
async function pgSet(json, ver) {
  await pgPool.query(
    `INSERT INTO appstate(id,data,ver,updated) VALUES(1,$1,$2,now())
     ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, ver=EXCLUDED.ver, updated=now()`,
    [json, ver]);
}
function liteGet() {
  try { return sqlite.prepare('SELECT data, ver FROM appstate WHERE id=1').get() || null; }
  catch (e) { return null; }
}
function liteSet(json, ver) {
  sqlite.prepare(`INSERT INTO appstate(id,data,ver,updated) VALUES(1,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, ver=excluded.ver, updated=excluded.updated`)
    .run(json, ver);
}

async function readRow() {
  if (USE_PG) { try { return await pgGet(); } catch (e) { return { _dberr: e }; } }
  return liteGet();
}
async function writeRow(json, ver) {
  if (USE_PG) await pgSet(json, ver);
  else liteSet(json, ver);
}

async function getState() {
  const row = await readRow();
  if (row && row._dberr) throw row._dberr;   /* Postgres down → 500, never silent reset */
  if (!row) {
    const s = seedState();
    const ver = await setState(s);
    return { data: s, ver };
  }
  try {
    return { data: JSON.parse(row.data), ver: row.ver };
  } catch (e) {                                   /* بيانات تالفة → إعادة تهيئة */
    const s = seedState();
    const ver = await setState(s);
    return { data: s, ver };
  }
}
async function setState(data) {
  sanitizePasswords(data);   /* أي كلمة مرور بنص واضح تُشفَّر قبل التخزين */
  let ver;
  if (USE_PG) {
    const r = await pgPool.query('SELECT ver FROM appstate WHERE id=1');
    ver = (r.rows[0] ? r.rows[0].ver : 0) + 1;
    await pgSet(JSON.stringify(data), ver);
  } else {
    const cur = sqlite.prepare('SELECT ver FROM appstate WHERE id=1').get();
    ver = (cur ? cur.ver : 0) + 1;
    liteSet(JSON.stringify(data), ver);
  }
  return ver;
}
/* ---- تشفير كلمات المرور (PBKDF2-SHA256 — مدمج في Node، بلا مكتبات) ----
   التخزين بصيغة: pbkdf2$iterations$salt$hash — لا يمكن عكسها لكلمة المرور */
const HASH_ITERS = 100000;
function isHash(s){ return typeof s === 'string' && s.indexOf('pbkdf2$') === 0; }
function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('base64');
  const key = crypto.pbkdf2Sync(String(pw), salt, HASH_ITERS, 32, 'sha256').toString('base64');
  return 'pbkdf2$' + HASH_ITERS + '$' + salt + '$' + key;
}
function verifyPassword(pw, stored){
  if(!isHash(stored)) return String(stored) === String(pw);   /* حساب قديم بنص واضح */
  try{
    const parts = String(stored).split('$');
    const k2 = crypto.pbkdf2Sync(String(pw), parts[2], Number(parts[1]), 32, 'sha256');
    const k1 = Buffer.from(parts[3], 'base64');
    return k2.length === k1.length && crypto.timingSafeEqual(k2, k1);
  }catch(e){ return false; }
}
function sanitizePasswords(data){
  if(data && Array.isArray(data.users)) data.users.forEach(u=>{
    if(u && typeof u.p === 'string' && u.p && !isHash(u.p)) u.p = hashPassword(u.p);
  });
  return data;
}
function getCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  const item = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
function csrfToken(token) {
  return crypto.createHmac('sha256', sessionSecret).update(token).digest('hex');
}
function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === `${req.protocol}://${req.get('host')}` || allowedOrigins.has(origin);
}
function auth(req,res, options = {}) {
  const token = getCookie(req, sessionCookie);
  const s = sessions.get(token);
  if(!s || Date.now() - s.at > SESSION_TTL){
    if (!options.silent) res.status(401).json({error:'AUTH'});
    return null;
  }
  if (!originAllowed(req)) { if (!options.silent) res.status(403).json({error:'ORIGIN'}); return null; }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (req.headers['x-csrf-token'] !== csrfToken(token)) { if (!options.silent) res.status(403).json({error:'CSRF'}); return null; }
  }
  s.at = Date.now();
  return { token, session: s };
}

/* ---- تسجيل الدخول ---- */
app.post('/api/login', loginRateLimit, async (req,res)=>{
  let st;
  try { st = await getState(); }
  catch (e) { console.error('DB error on /api/login:', e.message); return res.status(500).json({error:'DB'}); }
  const {u,p} = req.body || {};
  const rawU = String(u||'').trim().toLowerCase();
  const uname = rawU.includes('@') ? rawU.split('@')[0] : rawU;
  /* الدخول باسم المستخدم أو البريد الإلكتروني */
  const user = (st.data.users||[]).find(x => {
    const uu = String(x.u || '').toLowerCase();
    const em = String(x.email || '').toLowerCase();
    return (uu === rawU || uu === uname || (em && em === rawU)) && verifyPassword(String(p||''), x.p);
  });
  if(!user)  return res.status(401).json({error:'BAD_LOGIN'});
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = csrfToken(token);
  sessions.set(token,{userId:user.id, role:user.role || 'viewer', at:Date.now()});
  res.cookie(sessionCookie, token, { httpOnly:true, secure:isProduction, sameSite:'lax', maxAge:SESSION_TTL, path:'/' });
  res.json({userId:user.id, user:{id:user.id,name:user.name,role:user.role}, csrf, ver:st.ver});
});

app.post('/api/logout',(req,res)=>{
  const a = auth(req,res); if(!a) return;
  sessions.delete(a.token);
  res.clearCookie(sessionCookie, { httpOnly:true, secure:isProduction, sameSite:'lax', path:'/' });
  res.json({ok:true});
});

/* ---- قراءة الحالة (يُسمح بلا توكن فقط إذا القاعدة فارغة لأول تهيئة) ---- */
app.get('/api/state', async (req,res)=>{
  let cur;
  try { cur = await getState(); }
  catch (e) { console.error('DB error on GET /api/state:', e.message); return res.status(500).json({error:'DB'}); }
  const actor = cur.data ? auth(req,res) : null;
  if(cur.data && !actor) return;
  res.json(cur.data ? { ...cur, userId: actor.session.userId, role: actor.session.role } : cur);
});

/* ---- حفظ الحالة (مع كشف تعارض التعديل المتزامن) ---- */
app.post('/api/state', async (req,res)=>{
  let cur;
  try { cur = await getState(); }
  catch (e) { console.error('DB error on POST /api/state:', e.message); return res.status(500).json({error:'DB'}); }
  if(cur.data && !auth(req,res)) return;
  const {baseVer,data} = req.body || {};
  if(!data) return res.status(400).json({error:'NO_DATA'});
  if(cur.data && Number(baseVer) !== cur.ver)
    return res.status(409).json({error:'CONFLICT', ver:cur.ver});
  try {
    const ver = await setState(data);
    res.json({ok:true, ver});
  } catch (e) { console.error('DB error on save:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- بوابة المستأجرين العامة (بدون دخول): قائمة المجمعات ---- */
app.get('/api/public/compounds', async (req, res) => {
  let st;
  try { st = await getState(); }
  catch (e) { return res.status(500).json({ error: 'DB' }); }
  res.json((st.data.compounds || []).map(c => ({ id: c.id, name: c.name })));
});

/* ---- بوابة المستأجرين: إرسال بلاغ جديد (يتحول لأمر شغل) ---- */
app.post('/api/public/requests', pubLimit, async (req, res) => {
  try {
    const b = req.body || {};
    const compoundId = String(b.compoundId || '');
    const name = String(b.name || '').trim().slice(0, 80);
    const phone = normPhone(b.phone).slice(0, 20);
    const title = String(b.title || '').trim().slice(0, 140);
    const details = String(b.details || '').trim().slice(0, 2000);
    const unitCode = String(b.unitCode || '').trim().slice(0, 30);
    const cat = String(b.cat || '').trim().slice(0, 40);
    if (!compoundId || !name || phone.length < 9 || !title)
      return res.status(400).json({ error: 'MISSING' });
    const out = await serialized(async () => {
      const st = await getState();
      if (!(st.data.compounds || []).some(c => c.id === compoundId))
        return { err: 400 };
      st.data.seq = (st.data.seq || 0) + 1;
      const y = new Date().getFullYear();
      const wo = {
        id: 'W' + crypto.randomBytes(6).toString('hex'),
        no: 'WO-' + y + '-' + String(st.data.seq).padStart(4, '0'),
        type: 'fault', compoundId, status: 'open',
        title: (cat ? '[' + cat + '] ' : '') + title, desc: details,
        assetId: '', assetName: '', bname: '', priority: 'normal',
        assigneeId: '', assigneeName: '',
        dueDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
        projectId: '', unitId: '', unitCode, tenantName: name,
        source: 'portal', requester: { name, phone }, trackToken: crypto.randomBytes(18).toString('hex'), cat,
        createdAt: Date.now(), startedAt: null, closedAt: null,
        cost: 0, closeNotes: '', parts: [], photos: [], sig: '',
      };
      st.data.wos.unshift(wo);
      const ver = await setState(st.data);
      return { no: wo.no, token: wo.trackToken, ver };
    });
    if (out.err) return res.status(out.err).json({ error: 'BAD_COMPOUND' });
    res.json({ ok: true, no: out.no, token: out.token });
  } catch (e) { console.error('DB error on POST /api/public/requests:', e.message); return res.status(500).json({ error: 'DB' }); }
});

/* ---- بوابة المستأجرين: تتبع بلاغاتي برقم الجوال ---- */
app.get('/api/public/requests', pubLimit, async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (token.length < 20) return res.status(400).json({ error: 'MISSING' });
  let st;
  try { st = await getState(); }
  catch (e) { return res.status(500).json({ error: 'DB' }); }
  const mine = (st.data.wos || []).filter(w => {
    if (w.source !== 'portal' || !w.trackToken || String(w.trackToken).length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(String(w.trackToken)), Buffer.from(token));
  });
  res.json(mine.slice(0, 30).map(w => ({
    no: w.no, title: w.title, status: w.status,
    createdAt: w.createdAt, closedAt: w.closedAt || null,
  })));
});

/* ---- SPA fallback: أي مسار غير /api يرجع الواجهة ---- */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, HOST, async ()=>{
  if (USE_PG) {
    try { await pgInit(); console.log('✅ Postgres connected'); }
    catch (e) { console.error('⚠️ Postgres init failed (will retry per request):', e.message); }
  }
  console.log('✅ CMMS server running:');
  console.log('   DB:      ' + DB_LABEL);
  console.log('   Local:   http://localhost:' + PORT);
  const os=require('os'), ifs=os.networkInterfaces();
  Object.keys(ifs).forEach(k=>(ifs[k]||[]).forEach(i=>{
    if(i.family==='IPv4' && !i.internal) console.log('   Network: http://'+i.address+':'+PORT);
  }));
});

/* ---- graceful shutdown (Docker / Render) ---- */
function shutdown(sig){
  console.log('Received ' + sig + ', closing...');
  server.close(() => {
    try { if (sqlite) sqlite.close(); } catch(e){}
    if (pgPool) pgPool.end().catch(()=>{}).finally(()=>process.exit(0));
    else process.exit(0);
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
