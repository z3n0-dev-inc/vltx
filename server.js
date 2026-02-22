const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const { MongoClient } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Cloudinary ────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'djiebpwfn',
  api_key:    process.env.CLOUDINARY_API_KEY    || '327694518319195',
  api_secret: process.env.CLOUDINARY_API_SECRET || '1BUGv_7Y9X1JWgSKErYSVAyGtUA',
});

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://landenfortnite62_db_user:NvBSWNdfl7UsYdZ0@vltxlol.mace4ke.mongodb.net/?appName=vltxlol';

let db;
async function getDB() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('vltx');
  return db;
}

// ── Multer (memory storage — files go straight to Cloudinary) ─────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// Helper: upload buffer to Cloudinary
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    Readable.from(buffer).pipe(stream);
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API: Save profile ─────────────────────────────────────────────────────────
app.post('/api/profile', async (req, res) => {
  const { username, data } = req.body;
  if (!username || !/^[a-zA-Z0-9_.\-]{2,30}$/.test(username))
    return res.status(400).json({ error: 'Invalid username (2-30 chars, letters/numbers/._-)' });
  try {
    const database = await getDB();
    const key = username.toLowerCase();
    await database.collection('profiles').updateOne(
      { username: key },
      { $set: { ...data, username: key, updatedAt: Date.now() } },
      { upsert: true }
    );
    await database.collection('views').updateOne(
      { username: key },
      { $setOnInsert: { views: 0 } },
      { upsert: true }
    );
    res.json({ ok: true, url: `/${key}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── API: Get profile ──────────────────────────────────────────────────────────
app.get('/api/profile/:username', async (req, res) => {
  try {
    const database = await getDB();
    const p = await database.collection('profiles').findOne({ username: req.params.username.toLowerCase() });
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── API: Views ────────────────────────────────────────────────────────────────
app.post('/api/view/:username', async (req, res) => {
  try {
    const database = await getDB();
    const key = req.params.username.toLowerCase();
    const result = await database.collection('views').findOneAndUpdate(
      { username: key },
      { $inc: { views: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ views: result.views });
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/view/:username', async (req, res) => {
  try {
    const database = await getDB();
    const doc = await database.collection('views').findOne({ username: req.params.username.toLowerCase() });
    res.json({ views: doc ? doc.views : 0 });
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── File uploads → Cloudinary ─────────────────────────────────────────────────
app.post('/api/upload/avatar', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'vltx/avatars',
      resource_type: 'image',
    });
    res.json({ url: result.secure_url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/upload/background', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'vltx/backgrounds',
      resource_type: 'image',
    });
    res.json({ url: result.secure_url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/upload/music', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'vltx/music',
      resource_type: 'video', // Cloudinary uses "video" for audio files
    });
    const name = path.parse(req.file.originalname).name;
    res.json({ url: result.secure_url, name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ── Static pages ──────────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/customize', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customize.html')));

// ── Profile pages /:username ──────────────────────────────────────────────────
const RESERVED = ['api', 'uploads', 'favicon.ico', 'customize', '404'];
app.get('/:username', async (req, res) => {
  const key = req.params.username.toLowerCase();
  if (RESERVED.some(r => key.startsWith(r)))
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  try {
    const database = await getDB();
    const p = await database.collection('profiles').findOne({ username: key });
    if (!p) return res.sendFile(path.join(__dirname, 'public', '404.html'));
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
  } catch {
    res.sendFile(path.join(__dirname, 'public', '404.html'));
  }
});

app.listen(PORT, () => console.log(`✅ VLTX running → http://localhost:${PORT}`));
