const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Directories ──────────────────────────────────────────────────────────────
const UPLOAD_ROOT = process.env.RENDER ? '/var/data/uploads' : path.join(__dirname, 'uploads');
['avatars','backgrounds','music'].forEach(d =>
  fs.mkdirSync(path.join(UPLOAD_ROOT, d), { recursive: true })
);

// ── JSON database ─────────────────────────────────────────────────────────────
const DB_FILE = process.env.RENDER ? '/var/data/db.json' : path.join(__dirname, 'db.json');
function readDB()  { try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return {profiles:{},views:{}}; } }
function writeDB(d){ fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }
if (!fs.existsSync(DB_FILE)) writeDB({profiles:{},views:{}});

// ── Multer ────────────────────────────────────────────────────────────────────
function makeStorage(folder) {
  return multer.diskStorage({
    destination: (_,__,cb) => cb(null, path.join(UPLOAD_ROOT, folder)),
    filename:    (_,file,cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    }
  });
}
const uploadAvatar = multer({ storage: makeStorage('avatars'),     limits:{ fileSize: 8*1024*1024  } });
const uploadBg     = multer({ storage: makeStorage('backgrounds'), limits:{ fileSize: 200*1024*1024 } });
const uploadMusic  = multer({ storage: makeStorage('music'),       limits:{ fileSize: 50*1024*1024  } });

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit:'5mb' }));
app.use(express.static(path.join(__dirname,'public')));
app.use('/uploads', express.static(UPLOAD_ROOT));

// ── API: Save profile ─────────────────────────────────────────────────────────
app.post('/api/profile', (req, res) => {
  const { username, data } = req.body;
  if (!username || !/^[a-zA-Z0-9_.\-]{2,30}$/.test(username))
    return res.status(400).json({ error:'Invalid username (2-30 chars, letters/numbers/._-)' });
  const db  = readDB();
  const key = username.toLowerCase();
  db.profiles[key] = { ...data, username: key, updatedAt: Date.now() };
  if (!db.views[key]) db.views[key] = 0;
  writeDB(db);
  res.json({ ok:true, url:`/${key}` });
});

// ── API: Get profile ──────────────────────────────────────────────────────────
app.get('/api/profile/:username', (req, res) => {
  const db = readDB();
  const p  = db.profiles[req.params.username.toLowerCase()];
  if (!p) return res.status(404).json({ error:'Profile not found' });
  res.json(p);
});

// ── API: Views ────────────────────────────────────────────────────────────────
app.post('/api/view/:username', (req, res) => {
  const db  = readDB();
  const key = req.params.username.toLowerCase();
  db.views[key] = (db.views[key] || 0) + 1;
  writeDB(db);
  res.json({ views: db.views[key] });
});
app.get('/api/view/:username', (req, res) => {
  const db = readDB();
  res.json({ views: db.views[req.params.username.toLowerCase()] || 0 });
});

// ── File uploads ──────────────────────────────────────────────────────────────
app.post('/api/upload/avatar', uploadAvatar.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  res.json({ url:`/uploads/avatars/${req.file.filename}` });
});
app.post('/api/upload/background', uploadBg.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  res.json({ url:`/uploads/backgrounds/${req.file.filename}` });
});
app.post('/api/upload/music', uploadMusic.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  const name = path.parse(req.file.originalname).name;
  res.json({ url:`/uploads/music/${req.file.filename}`, name });
});

// ── Static pages ──────────────────────────────────────────────────────────────
app.get('/',         (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/customize',(req,res) => res.sendFile(path.join(__dirname,'public','customize.html')));

// ── Profile pages /:username ──────────────────────────────────────────────────
// Must come LAST so it doesn't swallow API/static routes
const RESERVED = ['api','uploads','favicon.ico','customize','404'];
app.get('/:username', (req, res) => {
  const key = req.params.username.toLowerCase();
  if (RESERVED.some(r => key.startsWith(r))) return res.status(404).sendFile(path.join(__dirname,'public','404.html'));
  const db = readDB();
  if (!db.profiles[key]) return res.sendFile(path.join(__dirname,'public','404.html'));
  res.sendFile(path.join(__dirname,'public','profile.html'));
});

app.listen(PORT, () => console.log(`✅ VLTX running → http://localhost:${PORT}`));
