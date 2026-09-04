/* ============================================
   CMMS Web Server — Express + Built-in SQLite
   (uses node:sqlite — no compilation needed)
   Production-ready: DATA_DIR persistent disk,
   /healthz, security headers, login rate-limit
   ============================================ */
const express  = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/* ---- Persistent storage: set DATA_DIR=/data on Render/Railway/Fly volume ---- */
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const DB_PATH = path.join(DATA_DIR, 'cmms.db');
const db   = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`CREATE TABLE IF NOT EXISTS appstate(
  id      INTEGER PRIMARY KEY CHECK(id=1),
  data    TEXT NOT NULL,
  ver     INTEGER NOT NULL DEFAULT 1,
  updated TEXT
)`);

const app = express();
app.set('trust proxy', 1);

/* ---- Minimal security headers (no extra deps) ---- */
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'SAMEORIGIN');
  res.header('Referrer-Policy', 'no-referrer-when-downgrade');
  next();
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '40mb' }));            /* الصور تُحفظ داخل البيانات */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/* ---- Health check (no auth — for Render/Fly/UpTimeRobot) ---- */
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/api/health', (req, res) => res.json({ ok: true, db: DB_PATH, time: new Date().toISOString() }));

/* ---- Simple login rate-limit: 20 attempts / 10 min per IP ---- */
const loginHits = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'x';
  const now = Date.now();
  const arr = (loginHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  arr.push(now);
  loginHits.set(ip, arr);
  if (arr.length > 20) return res.status(429).json({ error: 'TOO_MANY' });
  next();
}

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
  const U=o=>Object.assign({id:rid('U'),phone:'',cmpIds:null,activeCmp:''},o);
  const d={
    lang:'ar',ver:6,seq:0,prSeq:0,poSeq:0,rnSeq:0,prjSeq:0,ctSeq:0,seeded:false,
    users:[
      U({u:'admin',  p:'1234',name:'مدير النظام',   role:'admin'}),
      U({u:'eng',    p:'1234',name:'مهندس العمليات',role:'engineer'}),
      U({u:'sitemgr',p:'1234',name:'مدير الموقع',   role:'sitemgr'}),
      U({u:'sami',   p:'1234',name:'سامي العتيبي',  role:'tech'}),
      U({u:'khalid', p:'1234',name:'خالد منصور',    role:'tech'}),
      U({u:'store',  p:'1234',name:'مسؤول المخزون', role:'store'}),
      U({u:'proc',   p:'1234',name:'مسؤول المشتريات',role:'proc'})
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

function getState(){
  let row = null;
  try{ row = db.prepare('SELECT data, ver FROM appstate WHERE id=1').get(); }catch(e){ row = null; }
  if(!row){
    const s = seedState();
    return { data:s, ver:setState(s) };
  }
  try{
    return { data: JSON.parse(row.data), ver: row.ver };
  }catch(e){                                   /* بيانات تالفة → إعادة تهيئة */
    const s = seedState();
    return { data:s, ver:setState(s) };
  }
}
function setState(data){
  const cur = db.prepare('SELECT ver FROM appstate WHERE id=1').get();
  const ver = (cur ? cur.ver : 0) + 1;
  db.prepare(`INSERT INTO appstate(id,data,ver,updated) VALUES(1,?,?,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, ver=excluded.ver, updated=excluded.updated`)
    .run(JSON.stringify(data), ver);
  return ver;
}
function auth(req,res){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = sessions.get(token);
  if(!s){ res.status(401).json({error:'AUTH'}); return null; }
  s.at = Date.now();
  return token;
}

/* ---- تسجيل الدخول ---- */
app.post('/api/login', loginRateLimit, (req,res)=>{
  const {u,p} = req.body || {};
  const st = getState();
  const rawU = String(u||'').trim().toLowerCase();
  const uname = rawU.includes('@') ? rawU.split('@')[0] : rawU;
  const user = (st.data.users||[]).find(x=>(x.u.toLowerCase()===rawU || x.u.toLowerCase()===uname) && x.p===String(p||''));
  if(!user)  return res.status(401).json({error:'BAD_LOGIN'});
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token,{userId:user.id, at:Date.now()});
  res.json({token, userId:user.id, ver:st.ver});
});

app.post('/api/logout',(req,res)=>{
  const t = auth(req,res); if(!t) return;
  sessions.delete(t); res.json({ok:true});
});

/* ---- قراءة الحالة (يُسمح بلا توكن فقط إذا القاعدة فارغة لأول تهيئة) ---- */
app.get('/api/state',(req,res)=>{
  const cur = getState();
  if(cur.data && !auth(req,res)) return;
  res.json(cur);
});

/* ---- حفظ الحالة (مع كشف تعارض التعديل المتزامن) ---- */
app.post('/api/state',(req,res)=>{
  const cur = getState();
  if(cur.data && !auth(req,res)) return;
  const {baseVer,data} = req.body || {};
  if(!data) return res.status(400).json({error:'NO_DATA'});
  if(cur.data && Number(baseVer) !== cur.ver)
    return res.status(409).json({error:'CONFLICT', ver:cur.ver});
  const ver = setState(data);
  res.json({ok:true, ver});
});

/* ---- SPA fallback: أي مسار غير /api يرجع الواجهة ---- */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, HOST, ()=>{
  console.log('✅ CMMS server running:');
  console.log('   DB:      ' + DB_PATH);
  console.log('   Local:   http://localhost:' + PORT);
  const os=require('os'), ifs=os.networkInterfaces();
  Object.keys(ifs).forEach(k=>(ifs[k]||[]).forEach(i=>{
    if(i.family==='IPv4' && !i.internal) console.log('   Network: http://'+i.address+':'+PORT);
  }));
});

/* ---- graceful shutdown (Docker / Render) ---- */
function shutdown(sig){
  console.log('Received ' + sig + ', closing...');
  server.close(() => { try { db.close(); } catch(e){} process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
