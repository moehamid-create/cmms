/* ============================================
   CMMS Web Server — Express + SQLite / Postgres
   - Local / disk: built-in node:sqlite (no deps)
   - Cloud (free): Postgres via DATABASE_URL (Neon/Supabase),
     keeps data forever on Render's free plan (no disk needed)
   ============================================ */
const express  = require('express');
const compression = require('compression');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

/* ---- Minimal .env loader (no dependency): reads .env from the app folder.
   Real environment variables always win. .env.local is intentionally NOT loaded —
   it is reserved for the Neon CLI, so local runs never silently target production. ---- */
(function loadEnv(){
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (/^\s*(#|$)/.test(line)) continue;
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!m) continue;
      const key = m[1];
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let val = (m[2] || '').trim();
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
      process.env[key] = val;
    }
  } catch (e) { /* ignore malformed .env */ }
})();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const APP_VERSION = '1.1.0';
const STARTED_AT = Date.now();
let apiRequests = 0;

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
app.set('query parser', 'simple');   /* flat query parsing only — no qs nested-object vectors */
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
const sessionCookie = process.env.SESSION_COOKIE || 'cmms_session';
let sessionSecret = process.env.SESSION_SECRET || '';
if (!sessionSecret || sessionSecret.length < 32) {
  /* لا توقيف قاسٍ: ولّد سراً مؤقتاً حتى لا يتعطل النشر — الجلسات تُصفَّر عند إعادة التشغيل فقط */
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.error('⚠️ SESSION_SECRET missing/short — using an ephemeral one (set a persistent 32+ char value in Render → Environment for stable sessions)');
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
app.use(compression({ threshold: 1024 }));   /* Gzip للنصوص فوق 1KB */
/* سجل طلبات API (للمراقبة) + عدّاد — بدون تسجيل الأجساد أو الكوكيز */
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/healthz') return next();
  const t0 = Date.now();
  apiRequests++;
  res.on('finish', () => {
    console.log(`[api] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  /* الصور والملفات تُحفَظ مؤقتاً، لكن صفحة HTML دائماً طازجة (عشان التحديثات تظهر فوراً) */
  setHeaders: (res, fp) => { if (String(fp).endsWith('index.html')) res.setHeader('Cache-Control', 'no-store'); },
}));

/* ---- Health check (no auth — for Render/Fly/UpTimeRobot) ---- */
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/api/health', async (req, res) => {
  let dbOk = true, dbError = '';
  try {
    if (USE_PG) await pgPool.query('SELECT 1');
    else sqlite.prepare('SELECT 1').get();
  } catch (e) { dbOk = false; dbError = String(e.message || e).slice(0, 120); }
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk, db: DB_LABEL, version: APP_VERSION,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    apiRequests, time: new Date().toISOString(),
    ...(dbOk ? {} : { dbError }),
  });
});

/* ---- Client error reports (rate-limited, capped, no PII) ---- */
const errHits = new Map();
const errRing = [];
app.post('/api/client-errors', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'x';
  if (!boundedHit(errHits, ip, 60 * 60 * 1000, 20)) return res.status(429).json({ error: 'TOO_MANY' });
  const b = req.body || {};
  const msg = String(b.msg || '').slice(0, 200);
  const url = String(b.url || '').slice(0, 200);
  if (!msg) return res.status(400).json({ error: 'MISSING' });
  errRing.push({ at: new Date().toISOString(), ip: String(ip).slice(0, 40), msg, url });
  if (errRing.length > 50) errRing.shift();
  console.error(`[client-error] ${url} :: ${msg}`);
  res.json({ ok: true });
});

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
    lang:'ar',ver:8,seq:0,prSeq:0,poSeq:0,rnSeq:0,prjSeq:0,ctSeq:0,rfqSeq:0,seeded:false,
    users:[
      U({u:'admin',  p:'1234',name:'مدير النظام',   role:'admin', defaultPw:true}),
      U({u:'eng',    p:'1234',name:'مهندس العمليات', role:'engineer', defaultPw:true}),
      U({u:'sitemgr',p:'1234',name:'مدير الموقع',    role:'sitemgr', defaultPw:true}),
      U({u:'sami',   p:'1234',name:'سامي العتيبي',   role:'tech', defaultPw:true}),
      U({u:'khalid', p:'1234',name:'خالد منصور',     role:'tech', defaultPw:true}),
      U({u:'store',  p:'1234',name:'مسؤول المخزون',  role:'store', defaultPw:true}),
      U({u:'proc',   p:'1234',name:'مسؤول المشتريات',role:'proc', defaultPw:true})
    ],
    categories:['تكييف سبليت','تكييف مركزي / دكت','سخان مياه','مضخة مياه',
     'مضخة / فلتر مسبح','نظام معالجة مياه','جاكوزي / سبا','أجهزة الجيم','لوحة كهرباء','إنارة داخلية',
     'إنارة خارجية','مولد احتياطي','بوابة أوتوماتيكية','مصعد','نظام إنذار حريق','كاشف دخان',
     'طفاية حريق','شبكة إطفاء / رشاشات','سباكة وصنابير','أخرى'],
    compounds:[{id:C,name:'مجمع الخير السكني - حي الروضة',loc:'',notes:'',createdAt:Date.now()}],
    buildings:[],units:[],tenants:[],contracts:[],assets:[],wos:[],inv:[],moves:[],
    pms:[],suppliers:[],prs:[],pos:[],projects:[],employees:[],shifts:[],notifs:[],
    providers:[],rfqs:[]
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
function liteGet() {
  try { return sqlite.prepare('SELECT data, ver FROM appstate WHERE id=1').get() || null; }
  catch (e) { return null; }
}

async function readRow() {
  if (USE_PG) { try { return await pgGet(); } catch (e) { return { _dberr: e }; } }
  return liteGet();
}

/* يضمن وجود مصفوفات السوق والعدادات حتى في قواعد البيانات القديمة */
function normalizeState(d){
  if(!d) return d;
  ['providers','rfqs'].forEach(k=>{ if(!Array.isArray(d[k])) d[k]=[]; });
  if(d.rfqSeq==null) d.rfqSeq=0;
  ['seq','prSeq','poSeq','rnSeq','prjSeq','ctSeq'].forEach(k=>{ if(d[k]==null) d[k]=0; });
  if(!Array.isArray(d.users)) d.users=[];
  if(!Array.isArray(d.compounds)) d.compounds=[];
  if(!Array.isArray(d.assets)) d.assets=[];
  return d;
}

async function getState() {
  const row = await readRow();
  if (row && row._dberr) throw row._dberr;   /* Postgres down → 500, never silent reset */
  if (!row) {
    const s = normalizeState(seedState());
    const ver = await setState(s);
    return { data: s, ver };
  }
  try {
    return { data: normalizeState(JSON.parse(row.data)), ver: row.ver };
  } catch (e) {                                   /* بيانات تالفة → إعادة تهيئة */
    const s = normalizeState(seedState());
    const ver = await setState(s);
    return { data: s, ver };
  }
}
/* Atomic write. With expectedVer it is a compare-and-swap: returns the new
   version, or null if another writer bumped it first (caller → 409).
   Without expectedVer (first seed) it upserts and starts at ver 1. */
async function setState(data, expectedVer) {
  sanitizePasswords(data);   /* أي كلمة مرور بنص واضح تُشفَّر قبل التخزين */
  const json = JSON.stringify(data);
  if (USE_PG) {
    if (expectedVer == null) {
      const r = await pgPool.query(
        `INSERT INTO appstate(id,data,ver,updated) VALUES(1,$1,1,now())
         ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, ver=appstate.ver+1, updated=now()
         RETURNING ver`, [json]);
      return r.rows[0].ver;
    }
    const r = await pgPool.query(
      `UPDATE appstate SET data=$1, ver=ver+1, updated=now()
       WHERE id=1 AND ver=$2 RETURNING ver`, [json, expectedVer]);
    return r.rows[0] ? r.rows[0].ver : null;
  }
  if (expectedVer == null) {
    const r = sqlite.prepare(
      `INSERT INTO appstate(id,data,ver,updated) VALUES(1,?,1,datetime('now'))
       ON CONFLICT(id) DO UPDATE SET data=excluded.data, ver=ver+1, updated=excluded.updated
       RETURNING ver`).get(json);
    return r.ver;
  }
  const r = sqlite.prepare(
    `UPDATE appstate SET data=?, ver=ver+1, updated=datetime('now')
     WHERE id=1 AND ver=? RETURNING ver`).get(json, expectedVer);
  return r ? r.ver : null;
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
/* مقارنة ثابتة لمصفوفة المستخدمين (ترتيب المفاتيح لا يؤثر) */
function canonUsers(users) {
  return JSON.stringify((users || []).map(u => {
    const o = {};
    Object.keys(u || {}).sort().forEach(k => { o[k] = u[k]; });
    return o;
  }));
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

/* ============================================================
   السوق / منصة الملاك والمقدّمين (Marketplace)
   أدوار جديدة: owner (مالك) · contractor (مقاول/مزوّد خدمة) · supplier (مورّد)
   ============================================================ */
const MARKET_ROLES = ['owner','contractor','supplier'];
const SPECIALTIES = ['hvac','electrical','plumbing','general','carpentry','painting','landscape','lifts','security','other'];
const PRODUCT_LINES = ['building','spareparts','industrial','electrical','plumbing','hvac','safety','tools','other'];
function roleGuard(roles){
  return (req,res,next)=>{
    const a = auth(req,res,{silent:true});
    if(!a) return res.status(401).json({error:'AUTH'});
    if(!roles.includes(a.session.role)) return res.status(403).json({error:'FORBIDDEN'});
    req.auth = a;
    next();
  };
}
function pubProvider(p){
  return {
    id:p.id, type:p.type, bizName:p.bizName, contactName:p.contactName,
    phone:p.phone, email:p.email, city:p.city,
    specialty:p.specialty, coverage:p.coverage, productLines:p.productLines,
    deliveryScope:p.deliveryScope, crNo:p.crNo, tradeLicense:p.tradeLicense,
    catalogUrl:p.catalogUrl, portfolio:p.portfolio||[], rating:p.rating||0,
    verified:!!p.verified, status:p.status, createdAt:p.createdAt
  };
}
/* يبني ملف مقدّم خدمة من بيانات التسجيل */
function buildProvider(role, userId, b){
  const p = {
    id:'V'+crypto.randomBytes(6).toString('hex'),
    type: role,
    userId,
    bizName: String(b.bizName||'').trim().slice(0,120),
    contactName: String(b.name||'').trim().slice(0,80),
    phone: normPhone(b.phone).slice(0,20),
    email: String(b.email||'').trim().toLowerCase().slice(0,120),
    city: String(b.city||'').trim().slice(0,60),
    verified: false, status: 'pending', rating: 0, createdAt: Date.now()
  };
  if(role==='contractor'){
    p.specialty = String(b.specialty||'general').trim().slice(0,40);
    p.coverage = String(b.coverage||'').trim().slice(0,120);
    p.crNo = String(b.crNo||'').trim().slice(0,40);
    p.portfolio = (Array.isArray(b.portfolio)?b.portfolio:[]).slice(0,12)
      .map(x=>({name:String((x&&x.name)||'').slice(0,80), url:String((x&&x.url)||'').slice(0,300)})).filter(x=>x.name||x.url);
  } else {
    p.productLines = (Array.isArray(b.productLines)?b.productLines:[]).slice(0,12)
      .map(x=>String(x||'').slice(0,40)).filter(Boolean);
    p.deliveryScope = String(b.deliveryScope||'').trim().slice(0,120);
    p.tradeLicense = String(b.tradeLicense||'').trim().slice(0,80);
    p.catalogUrl = String(b.catalogUrl||'').trim().slice(0,300);
  }
  return p;
}
function actorRoleOwns(session, rfq){
  if(session.role==='admin' || session.role==='engineer') return true;
  return session.userId === rfq.ownerId;
}
function rfqVisibleTo(provider, rfq){
  if(rfq.status!=='open') return false;
  if(rfq.visibility==='direct')
    return (rfq.invitedProviderIds||[]).includes(provider.id);
  return rfq.type === (provider.type==='supplier' ? 'material' : 'maintenance');
}
function rfqViewFor(actor, rfq, includeBids){
  const base = {
    id:rfq.id, no:rfq.no, type:rfq.type, ownerName:rfq.ownerName,
    compoundName:rfq.compoundName, assetName:rfq.assetName, assetId:rfq.assetId,
    title:rfq.title, desc:rfq.desc, category:rfq.category,
    qty:rfq.qty, unit:rfq.unit, targetDate:rfq.targetDate,
    status:rfq.status, visibility:rfq.visibility, createdAt:rfq.createdAt,
    jobStatus:rfq.jobStatus, awardedBidId:rfq.awardedBidId
  };
  const myProvider = actor.role==='contractor'||actor.role==='supplier' ? actor.provider : null;
  if(includeBids || actor.role==='owner' || actor.role==='admin' || actor.role==='engineer'){
    base.bids = (rfq.bids||[]).map(b=>({
      id:b.id, providerId:b.providerId, providerName:b.providerName,
      amount:b.amount, note:b.note, createdAt:b.createdAt, status:b.status,
      invoice:b.invoice||null
    }));
  } else if(myProvider){
    base.bidCount = (rfq.bids||[]).length;
    const mine = (rfq.bids||[]).find(b=>b.providerId===myProvider.id);
    base.myBid = mine ? { id:mine.id, amount:mine.amount, note:mine.note, status:mine.status, createdAt:mine.createdAt } : null;
  } else {
    base.bidCount = (rfq.bids||[]).length;
  }
  return base;
}

/* ---- تسجيل الدخول ---- */
app.post('/api/login', loginRateLimit, async (req,res)=>{
  let st;
  try { st = await getState(); }
  catch (e) { console.error('DB error on /api/login:', e.message); return res.status(500).json({error:'DB'}); }
  const {u,p} = req.body || {};
  if (String(u || '').length > 200 || String(p || '').length > 200)
    return res.status(400).json({error:'BAD_LOGIN'});
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
  res.json({userId:user.id, user:{id:user.id,name:user.name,role:user.role}, csrf, ver:st.ver, mustChange:!!user.defaultPw});
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
  /* أدوار السوق (مالك/مقاول/مورّد) تستقبل نسخة معزولة — لا تصل لبيانات غيرها */
  if(cur.data && MARKET_ROLES.includes(actor.session.role)){
    const meU = (cur.data.users||[]).find(u=>u.id===actor.session.userId) || {id:actor.session.userId, name:'', role:actor.session.role, email:'', phone:'', u:''};
    return res.json({
      data: { lang: cur.data.lang, ver: cur.ver, users: [{id:meU.id, u:meU.u, name:meU.name, role:meU.role, email:meU.email, phone:meU.phone}] },
      ver: cur.ver, userId: actor.session.userId, role: actor.session.role, marketplace: true
    });
  }
  res.json(cur.data ? { ...cur, userId: actor.session.userId, role: actor.session.role } : cur);
});

/* ---- حفظ الحالة (مع كشف تعارض التعديل المتزامن + RBAC على المستخدمين) ---- */
app.post('/api/state', async (req,res)=>{
  let cur;
  try { cur = await getState(); }
  catch (e) { console.error('DB error on POST /api/state:', e.message); return res.status(500).json({error:'DB'}); }
  const actor = cur.data ? auth(req,res) : null;
  if(cur.data && !actor) return;
  /* أدوار السوق لا تكتب الحالة كاملة — تعتمد على مسارات السوق المخصصة */
  if(cur.data && MARKET_ROLES.includes(actor.session.role))
    return res.status(403).json({error:'FORBIDDEN'});
  const {baseVer,data} = req.body || {};
  if(!data) return res.status(400).json({error:'NO_DATA'});
  if(cur.data && Number(baseVer) !== cur.ver)
    return res.status(409).json({error:'CONFLICT', ver:cur.ver});
  /* إدارة المستخدمين للمدير فقط — تُقارن بالمحتوى (تغيير لغتي/مجمعي مسموح للجميع) */
  if (cur.data && canonUsers(data.users) !== canonUsers(cur.data.users) && actor.session.role !== 'admin')
    return res.status(403).json({error:'USERS_FORBIDDEN'});
  try {
    /* compare-and-swap: only writes if the version is still cur.ver, closing the
       read→write race that two simultaneous editors could otherwise slip through */
    const ver = await setState(data, cur.data ? cur.ver : null);
    if (ver == null) return res.status(409).json({error:'CONFLICT', ver:cur.ver});
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
      const ver = await setState(st.data, st.ver);
      if (ver == null) return { err: 409 };
      return { no: wo.no, token: wo.trackToken, ver };
    });
    if (out.err) return res.status(out.err).json({ error: out.err === 409 ? 'CONFLICT' : 'BAD_COMPOUND' });
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

/* ============================================================
   التسجيل الذاتي متعدد الأدوار (مالك / مقاول / مورّد)
   ============================================================ */
app.post('/api/signup', loginRateLimit, async (req,res)=>{
  try {
    const b = req.body || {};
    const role = String(b.role || '').trim();
    if(!MARKET_ROLES.includes(role)) return res.status(400).json({error:'BAD_ROLE'});
    const name = String(b.name || '').trim().slice(0,80);
    const email = String(b.email || '').trim().toLowerCase().slice(0,120);
    const phone = normPhone(b.phone).slice(0,20);
    const password = String(b.password || '');
    if(!name || password.length < 6 || password.length > 200)
      return res.status(400).json({error:'BAD_FIELDS'});
    if(email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({error:'BAD_EMAIL'});
    if(role!=='owner'){
      if(!String(b.bizName||'').trim()) return res.status(400).json({error:'BAD_BIZ'});
      if(role==='contractor' && !String(b.specialty||'').trim()) return res.status(400).json({error:'BAD_SPECIALTY'});
      if(role==='supplier' && !(Array.isArray(b.productLines) && b.productLines.length)) return res.status(400).json({error:'BAD_PRODUCT_LINES'});
    }
    const uname = ((email ? email.split('@')[0] : ('u'+phone)) || 'user')
      .toLowerCase().replace(/[^a-z0-9._-]/g,'').slice(0,40) || 'user'+Date.now().toString(36);
    const out = await serialized(async () => {
      const st = await getState();
      if(email && (st.data.users||[]).some(x => String(x.email||'').toLowerCase()===email))
        return { err:409, code:'EMAIL_TAKEN' };
      let un = uname, i = 1;
      while((st.data.users||[]).some(x => String(x.u||'').toLowerCase()===un)){ un = uname+'-'+i; i++; }
      const userId = 'U' + crypto.randomBytes(6).toString('hex');
      const user = { id:userId, u:un, p:hashPassword(password), name, role, phone, email, cmpIds:[], activeCmp:'', defaultPw:false };
      st.data.users.push(user);
      if(role==='contractor' || role==='supplier'){
        (st.data.providers||[]).push(buildProvider(role, userId, b));
      } else {
        /* المالك يبدأ بعقار افتراضي يملكه */
        st.data.compounds.push({ id:'C'+crypto.randomBytes(6).toString('hex'), name:(b.company?String(b.company).trim().slice(0,80):'')||(name+' — عقاري'), loc:'', notes:'', createdAt:Date.now(), ownerId:userId, kind:'property' });
      }
      const ver = await setState(st.data, st.ver);
      if(ver == null) return { err:409, code:'CONFLICT' };
      return { ok:true, userId };
    });
    if(out.err) return res.status(out.err).json({ error: out.code || 'ERR' });
    res.json({ ok:true });
  } catch(e){ console.error('DB error on POST /api/signup:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- بيانات السوق الخاصة بالمستخدم الحالي (معزولة حسب الدور) ---- */
app.get('/api/market/me', roleGuard(['owner','contractor','supplier','admin','engineer']), async (req,res)=>{
  try {
    const st = await getState();
    const actor = req.auth.session;
    const meU = (st.data.users||[]).find(u=>u.id===actor.userId) || {};
    const out = { role: actor.role, user: { id:meU.id, name:meU.name, role:meU.role, email:meU.email, phone:meU.phone } };
    if(actor.role==='contractor' || actor.role==='supplier'){
      const provider = (st.data.providers||[]).find(p=>p.userId===actor.userId) || null;
      out.profile = provider ? pubProvider(provider) : null;
      const pctx = { role: actor.role, provider };
      const visible = (st.data.rfqs||[])
        .filter(rfq => rfqVisibleTo(provider, rfq) || (rfq.awardedBidId && (rfq.bids||[]).some(b=>b.id===rfq.awardedBidId && b.providerId===provider.id)))
        .map(rfq => rfqViewFor(pctx, rfq, false));
      out.rfqs = visible;
      out.myJobs = (st.data.rfqs||[])
        .filter(rfq => rfq.awardedBidId && (rfq.bids||[]).some(b=>b.id===rfq.awardedBidId && b.providerId===provider.id))
        .map(rfq => rfqViewFor(pctx, rfq, true));
    } else if(actor.role==='owner'){
      const owned = (st.data.compounds||[]).filter(c=>c.ownerId===actor.userId);
      out.compounds = owned.map(c=>({id:c.id,name:c.name,kind:c.kind,loc:c.loc}));
      const cids = owned.map(c=>c.id);
      out.assets = (st.data.assets||[]).filter(a=>cids.includes(a.compoundId))
        .map(a=>({id:a.id,name:a.name,category:a.category,compoundId:a.compoundId,compoundName:(owned.find(c=>c.id===a.compoundId)||{}).name}));
      out.rfqs = (st.data.rfqs||[]).filter(rfq=>rfq.ownerId===actor.userId).map(rfq=>rfqViewFor({role:'owner'}, rfq, true));
      out.directory = (st.data.providers||[]).filter(p=>p.verified && p.status!=='suspended').map(pubProvider);
    } else {
      /* admin / engineer — إشراف كامل على السوق */
      out.providers = (st.data.providers||[]).map(pubProvider);
      out.rfqs = (st.data.rfqs||[]).map(rfq=>rfqViewFor({role:actor.role}, rfq, true));
      out.directory = (st.data.providers||[]).filter(p=>p.verified && p.status!=='suspended').map(pubProvider);
    }
    res.json(out);
  } catch(e){ console.error('DB error on GET /api/market/me:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- دليل مقدّمي الخدمة المعتمدين (بحث/تصفية) ---- */
app.get('/api/market/directory', roleGuard(['owner','contractor','supplier','admin','engineer']), async (req,res)=>{
  try {
    const st = await getState();
    let list = (st.data.providers||[]).filter(p=>p.verified && p.status!=='suspended');
    const type = String(req.query.type||'').trim();
    const specialty = String(req.query.specialty||'').trim();
    const city = String(req.query.city||'').trim();
    if(type) list = list.filter(p=>p.type===type);
    if(specialty) list = list.filter(p=>p.specialty===specialty || (p.productLines||[]).includes(specialty));
    if(city) list = list.filter(p=>String(p.city||'').toLowerCase().includes(city.toLowerCase()));
    list = list.slice(0,200).sort((a,b)=>(b.rating||0)-(a.rating||0));
    res.json(list.map(pubProvider));
  } catch(e){ console.error('DB error on GET /api/market/directory:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- إنشاء أمر صيانة / طلب عروض أسعار (RFQ) — للمالك ---- */
app.post('/api/market/rfqs', roleGuard(['owner','admin','engineer']), async (req,res)=>{
  try {
    const b = req.body || {};
    const type = (String(b.type||'')==='material') ? 'material' : 'maintenance';
    const title = String(b.title||'').trim().slice(0,140);
    const desc = String(b.desc||'').trim().slice(0,2000);
    if(!title) return res.status(400).json({error:'BAD_TITLE'});
    const visibility = String(b.visibility||'')==='direct' ? 'direct' : 'public';
    const out = await serialized(async () => {
      const st = await getState();
      const meU = (st.data.users||[]).find(u=>u.id===req.auth.session.userId) || {};
      st.data.rfqSeq = (st.data.rfqSeq||0) + 1;
      const y = new Date().getFullYear();
      const assetId = String(b.assetId||'');
      const asset = assetId ? (st.data.assets||[]).find(a=>a.id===assetId) : null;
      const compoundId = String(b.compoundId||(asset&&asset.compoundId)||'');
      const compound = compoundId ? (st.data.compounds||[]).find(c=>c.id===compoundId) : null;
      const rfq = {
        id:'R'+crypto.randomBytes(6).toString('hex'),
        no:'RFQ-'+y+'-'+String(st.data.rfqSeq).padStart(4,'0'),
        type, ownerId: req.auth.session.userId, ownerName: meU.name||'',
        compoundId, compoundName: compound?compound.name:'',
        assetId, assetName: asset ? asset.name : String(b.assetName||'').trim().slice(0,120),
        title, desc, category: String(b.category||'').trim().slice(0,60),
        qty: Number(b.qty)||1, unit: String(b.unit||'').trim().slice(0,30),
        targetDate: String(b.targetDate||'').slice(0,10),
        status:'open', visibility,
        invitedProviderIds: Array.isArray(b.invitedProviderIds)?b.invitedProviderIds.map(x=>String(x)).slice(0,50):[],
        bids:[], awardedBidId:'', jobStatus:'pending', createdAt: Date.now()
      };
      (st.data.rfqs||[]).unshift(rfq);
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true, no: rfq.no, id: rfq.id };
    });
    if(out.err) return res.status(409).json({error:'CONFLICT'});
    res.json(out);
  } catch(e){ console.error('DB error on POST /api/market/rfqs:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- تقديم عرض سعر — للمقاول/المورّد ---- */
app.post('/api/market/rfqs/:id/bid', roleGuard(['contractor','supplier']), async (req,res)=>{
  try {
    const id = String(req.params.id||'');
    const b = req.body || {};
    const amount = Number(b.amount);
    if(!(amount>0)) return res.status(400).json({error:'BAD_AMOUNT'});
    const note = String(b.note||'').trim().slice(0,1000);
    const out = await serialized(async () => {
      const st = await getState();
      const provider = (st.data.providers||[]).find(p=>p.userId===req.auth.session.userId);
      if(!provider) return { err:403 };
      const rfq = (st.data.rfqs||[]).find(r=>r.id===id);
      if(!rfq) return { err:404 };
      if(rfq.status!=='open' || !rfqVisibleTo(provider, rfq)) return { err:403 };
      const existing = (rfq.bids||[]).find(x=>x.providerId===provider.id);
      const bid = {
        id:'B'+crypto.randomBytes(6).toString('hex'),
        providerId: provider.id, providerName: provider.bizName||provider.contactName||'',
        amount, note, invoice: b.invoice?String(b.invoice).trim().slice(0,300):'',
        createdAt: Date.now(), status:'submitted'
      };
      if(existing) Object.assign(existing, bid, {id:existing.id});
      else rfq.bids.push(bid);
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true };
    });
    if(out.err) return res.status(out.err).json({error: out.err===404?'NOT_FOUND':'FORBIDDEN'});
    res.json(out);
  } catch(e){ console.error('DB error on bid:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- ترسية العرض — للمالك ---- */
app.post('/api/market/rfqs/:id/award', roleGuard(['owner','admin','engineer']), async (req,res)=>{
  try {
    const id = String(req.params.id||'');
    const bidId = String(req.body.bidId||'');
    const out = await serialized(async () => {
      const st = await getState();
      const rfq = (st.data.rfqs||[]).find(r=>r.id===id);
      if(!rfq) return { err:404 };
      if(actorRoleOwns(req.auth.session, rfq)===false) return { err:403 };
      const bid = (rfq.bids||[]).find(x=>x.id===bidId);
      if(!bid) return { err:400 };
      rfq.bids.forEach(x=>{ x.status = (x.id===bidId) ? 'awarded' : 'submitted'; });
      rfq.awardedBidId = bidId; rfq.status='awarded'; rfq.jobStatus='pending';
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true };
    });
    if(out.err) return res.status(out.err).json({error: out.err===404?'NOT_FOUND':'ERR'});
    res.json(out);
  } catch(e){ console.error('DB error on award:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- تحديث حالة التنفيذ — للمقاول/المورّد المرسى له ---- */
app.post('/api/market/rfqs/:id/status', roleGuard(['contractor','supplier']), async (req,res)=>{
  try {
    const id = String(req.params.id||'');
    const js = String(req.body.jobStatus||'');
    if(!['pending','inprogress','completed','paid'].includes(js)) return res.status(400).json({error:'BAD_STATUS'});
    const out = await serialized(async () => {
      const st = await getState();
      const provider = (st.data.providers||[]).find(p=>p.userId===req.auth.session.userId);
      if(!provider) return { err:403 };
      const rfq = (st.data.rfqs||[]).find(r=>r.id===id);
      if(!rfq) return { err:404 };
      if(!rfq.awardedBidId || !(rfq.bids||[]).some(x=>x.id===rfq.awardedBidId && x.providerId===provider.id)) return { err:403 };
      rfq.jobStatus = js;
      if(js==='completed' || js==='paid') rfq.status = js==='paid' ? 'closed' : rfq.status;
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true };
    });
    if(out.err) return res.status(out.err).json({error: out.err===404?'NOT_FOUND':'FORBIDDEN'});
    res.json(out);
  } catch(e){ console.error('DB error on status:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- إغلاق/إلغاء RFQ — للمالك ---- */
app.post('/api/market/rfqs/:id/close', roleGuard(['owner','admin','engineer']), async (req,res)=>{
  try {
    const id = String(req.params.id||'');
    const out = await serialized(async () => {
      const st = await getState();
      const rfq = (st.data.rfqs||[]).find(r=>r.id===id);
      if(!rfq) return { err:404 };
      if(actorRoleOwns(req.auth.session, rfq)===false) return { err:403 };
      rfq.status='closed';
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true };
    });
    if(out.err) return res.status(out.err).json({error: out.err===404?'NOT_FOUND':'ERR'});
    res.json(out);
  } catch(e){ console.error('DB error on close:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- اعتماد/تعليق مقدّم خدمة — للمدير/المهندس ---- */
app.post('/api/market/providers/:id/verify', roleGuard(['admin','engineer']), async (req,res)=>{
  try {
    const id = String(req.params.id||'');
    const action = String(req.body.action||'approve');
    const out = await serialized(async () => {
      const st = await getState();
      const p = (st.data.providers||[]).find(x=>x.id===id);
      if(!p) return { err:404 };
      if(action==='suspend'){ p.status='suspended'; }
      else { p.verified=true; p.status='active'; }
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true };
    });
    if(out.err) return res.status(out.err).json({error: out.err===404?'NOT_FOUND':'ERR'});
    res.json(out);
  } catch(e){ console.error('DB error on verify:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- إضافة/تعديل أصل للمالك (مستعمل في ربط أوامر السوق) ---- */
app.post('/api/market/assets', roleGuard(['owner']), async (req,res)=>{
  try {
    const b = req.body || {};
    const compoundId = String(b.compoundId||'');
    const name = String(b.name||'').trim().slice(0,120);
    if(!compoundId || !name) return res.status(400).json({error:'MISSING'});
    const out = await serialized(async () => {
      const st = await getState();
      const cmp = (st.data.compounds||[]).find(c=>c.id===compoundId);
      if(!cmp || cmp.ownerId!==req.auth.session.userId) return { err:403 };
      const asset = { id:'A'+crypto.randomBytes(6).toString('hex'), name, category:String(b.category||'').trim().slice(0,60),
        building:'', compoundId, floor:'', detail:'', model:'', serial:'', installdate:'', warrantyend:'', status:'ok', notes:'', projectId:'', photos:[] };
      (st.data.assets||[]).push(asset);
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true, id:asset.id };
    });
    if(out.err) return res.status(out.err).json({error: out.err===409?'CONFLICT':'FORBIDDEN'});
    res.json(out);
  } catch(e){ console.error('DB error on assets:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ---- إضافة عقار للمالك ---- */
app.post('/api/market/compounds', roleGuard(['owner']), async (req,res)=>{
  try {
    const b = req.body || {};
    const name = String(b.name||'').trim().slice(0,120);
    if(!name) return res.status(400).json({error:'MISSING'});
    const out = await serialized(async () => {
      const st = await getState();
      st.data.compounds.push({ id:'C'+crypto.randomBytes(6).toString('hex'), name, loc:String(b.loc||'').trim().slice(0,80), notes:'', createdAt:Date.now(), ownerId:req.auth.session.userId, kind:'property' });
      const ver = await setState(st.data, st.ver);
      if(ver==null) return { err:409 };
      return { ok:true };
    });
    if(out.err) return res.status(409).json({error:'CONFLICT'});
    res.json(out);
  } catch(e){ console.error('DB error on compounds:', e.message); return res.status(500).json({error:'DB'}); }
});

/* ============================================================
   AI helper (اختياري) — توليد/تحسين خطط الصيانة الوقائية
   يعمل مع Neon AI Gateway أو أي نقطة متوافقة مع OpenAI.
   لا يُشترط أي مفتاح: عند غيابه ترجع الواجهة للمكتبة المحلية.
   ============================================================ */
function aiConfig(){
  const nTok = process.env.NEON_AI_GATEWAY_TOKEN;
  const nBase = process.env.NEON_AI_GATEWAY_BASE_URL;
  if (nTok && nBase) {
    return { url: nBase.replace(/\/+$/, '') + '/v1/chat/completions', key: nTok,
      model: process.env.AI_MODEL || process.env.NEON_AI_MODEL || 'gpt-5-mini', provider: 'neon' };
  }
  const oKey = process.env.OPENAI_API_KEY;
  if (oKey) {
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    return { url: base + '/chat/completions', key: oKey,
      model: process.env.AI_MODEL || 'gpt-4o-mini', provider: 'openai' };
  }
  return null;
}
function safeJson(txt){
  if (!txt) return null;
  let s = String(txt).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (e) { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}
const AI_SYSTEM = [
  'You are a senior facilities-management engineer specialising in preventive maintenance (PM) planning for residential compounds and mixed-use properties in Saudi Arabia.',
  'You receive a list of building types and the systems/equipment installed in them.',
  'For EACH given system key, propose or refine ONE realistic PM plan.',
  'Return STRICT JSON only, no prose, in this exact shape:',
  '{"plans":[{"system":"<the system key exactly as given>","name":"<short plan name>","freqVal":<integer>,"freqUnit":"days|weeks|months","tasks":["<step>","<step>"]}]}',
  'Rules: freqUnit must be one of days, weeks, months. Provide 4 to 8 concrete checklist tasks per plan. Use realistic intervals (e.g. split A/C filters every 3 months, elevator monthly, fire extinguishers yearly, pool filtration weekly).',
  'Write names and tasks in the requested language (ar = Arabic, en = English).',
].join(' ');

app.get('/api/ai/status', (req, res) => {
  const a = auth(req, res, { silent: true });
  if (!a) return res.status(401).json({ error: 'AUTH' });
  const c = aiConfig();
  res.json({ ok: !!c, provider: c ? c.provider : null, model: c ? c.model : null });
});

const aiHits = new Map();
app.post('/api/ai/pm-suggest', async (req, res) => {
  const a = auth(req, res);
  if (!a) return;
  if (!['admin', 'engineer'].includes(a.session.role)) return res.status(403).json({ error: 'FORBIDDEN' });
  const ip = req.ip || req.socket.remoteAddress || 'x';
  if (!boundedHit(aiHits, ip, 60 * 60 * 1000, 40)) return res.status(429).json({ error: 'TOO_MANY' });
  const c = aiConfig();
  if (!c) return res.json({ ok: false, reason: 'AI_NOT_CONFIGURED' });
  try {
    const b = req.body || {};
    const lang = b.lang === 'en' ? 'en' : 'ar';
    const systems = (Array.isArray(b.systems) ? b.systems : []).slice(0, 80).map(s => ({
      system: String((s && s.system) || '').slice(0, 40),
      label: String((s && s.label) || '').slice(0, 120),
      asset: String((s && s.asset) || '').slice(0, 120),
      category: String((s && s.category) || '').slice(0, 80),
      buildings: Number((s && s.buildings) || 1) || 1,
      qty: Number((s && s.qty) || 1) || 1,
    })).filter(s => s.system);
    if (!systems.length) return res.status(400).json({ error: 'NO_SYSTEMS' });
    const userMsg = JSON.stringify({
      language: lang,
      compound: String(b.compoundName || '').slice(0, 120),
      buildingTypes: (Array.isArray(b.buildingTypes) ? b.buildingTypes : []).slice(0, 20).map(x => ({
        type: String((x && x.type) || '').slice(0, 30),
        name: String((x && x.name) || '').slice(0, 80),
        buildings: Number((x && x.buildings) || 1) || 1,
      })),
      systems,
    });
    const body = {
      model: c.model,
      temperature: 0.2,
      messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: userMsg }],
    };
    let r = await aiFetch(c, Object.assign({}, body, { response_format: { type: 'json_object' } }));
    if (!r.ok && (r.status === 400 || r.status === 422)) {
      r = await aiFetch(c, body);   /* بعض المزودين لا يدعمون response_format */
    }
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[ai] HTTP', r.status, String(txt).slice(0, 160));
      return res.json({ ok: false, reason: 'AI_HTTP_' + r.status });
    }
    const j = await r.json();
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const parsed = safeJson(content);
    if (!parsed || !Array.isArray(parsed.plans)) return res.json({ ok: false, reason: 'AI_BAD_OUTPUT' });
    const FU = ['days', 'weeks', 'months'];
    const plans = parsed.plans.slice(0, 120).map(p => ({
      system: String((p && p.system) || '').slice(0, 40),
      name: String((p && p.name) || '').slice(0, 120),
      freqVal: Math.max(1, Math.min(365, parseInt(p && p.freqVal, 10) || 1)),
      freqUnit: FU.includes(String((p && p.freqUnit) || '').toLowerCase()) ? String(p.freqUnit).toLowerCase() : 'months',
      tasks: (Array.isArray(p && p.tasks) ? p.tasks : []).slice(0, 12).map(t => String(t).slice(0, 200)).filter(Boolean),
    })).filter(p => p.system && p.tasks.length);
    res.json({ ok: true, provider: c.provider, model: c.model, plans });
  } catch (e) {
    console.error('[ai] error:', e.message);
    res.json({ ok: false, reason: 'AI_ERROR' });
  }
});
async function aiFetch(c, payload) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 25000);
  try {
    return await fetch(c.url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
      body: JSON.stringify(payload),
    });
  } finally { clearTimeout(to); }
}

/* ---- 404 لأي مسار API غير معروف (JSON) ---- */
app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

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
