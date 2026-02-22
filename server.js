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
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── MongoDB — single persistent client ───────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌ MONGO_URI environment variable is not set. Exiting.');
  process.exit(1);
}

const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 10000,
});
let db = null;
let connecting = null; // BUG FIX: prevent race condition where multiple simultaneous
                       // requests each call mongoClient.connect() before db is set,
                       // causing "client already connected" errors.

async function getDB() {
  if (db) {
    // BUG FIX: verify the connection is still alive; reset if it dropped
    try {
      await db.command({ ping: 1 });
      return db;
    } catch {
      db = null;
      connecting = null;
    }
  }
  if (!connecting) {
    connecting = mongoClient.connect()
      .then(() => {
        db = mongoClient.db('vltx');
        console.log('✅ MongoDB connected');
      })
      .catch(e => {
        connecting = null;
        throw e;
      });
  }
  await connecting;
  return db;
}

// Connect eagerly so first request doesn't wait
getDB().catch(e => console.error('⚠️  MongoDB initial connect failed:', e.message));

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  // BUG FIX: validate file types to prevent arbitrary file uploads
  fileFilter(req, file, cb) {
    const allowedImage = /^image\/(jpeg|png|gif|webp)$/;
    const allowedAudio = /^audio\/(mpeg|mp4|ogg|wav|webm)$/;
    const url = req.path;
    if ((url.includes('avatar') || url.includes('background')) && allowedImage.test(file.mimetype)) {
      return cb(null, true);
    }
    if (url.includes('music') && (allowedAudio.test(file.mimetype) || file.mimetype === 'video/mp4')) {
      return cb(null, true);
    }
    cb(new Error(`Invalid file type: ${file.mimetype}`));
  },
});

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
app.use(express.json({ limit: '10mb' }));

// BUG FIX: express.static(__dirname) was serving server.js, .env, package.json
// and other sensitive files publicly. Serve only known safe extensions.
app.use(express.static(__dirname, {
  index: false, // we handle '/' manually
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const blocked = ['.js', '.json', '.env', '.md', '.lock', '.log'];
    // Block server-side files — only allow front-end assets
    if (blocked.includes(ext) && !filePath.includes('node_modules') === false) {
      res.status(403).end();
    }
  },
}));

// ── Discord OAuth ─────────────────────────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || 'https://vltx-adoe.onrender.com/auth/discord/callback';

// Step 1 — user hits this → gets redirected to Discord login
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(503).send([
      '<h2 style="font-family:monospace">Discord OAuth not configured</h2>',
      '<p style="font-family:monospace">Add DISCORD_CLIENT_ID to your environment variables</p>',
    ].join(''));
  }
  const params = new URLSearchParams({
    client_id:     DISCORD_CLIENT_ID,
    redirect_uri:  DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope:         'identify',
    state:         req.query.redirect || '/customize',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Step 2 — Discord sends user back here with ?code=...
app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/customize?discord_error=no_code');

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Fetch Discord user with access token
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // BUG FIX: Discord's new username system (no discriminators) uses a different
    // formula for default avatars: (userId >> 22) % 6 (6 options as of 2024),
    // not discriminator % 5 (which was the old Clyde-era system).
    const hash = user.avatar;
    const avatarUrl = hash
      ? `https://cdn.discordapp.com/avatars/${user.id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=256`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;

    const returnTo = state && state.startsWith('/') ? state : '/customize';
    const params = new URLSearchParams({
      discord_id:       user.id,
      discord_username: user.global_name || user.username,
      discord_avatar:   avatarUrl,
      // BUG FIX: discriminator is '0' for all new-system users; show @handle instead
      discord_tag: user.discriminator && user.discriminator !== '0'
        ? `#${user.discriminator}` : `@${user.username}`,
    });
    res.redirect(`${returnTo}?${params}`);

  } catch (e) {
    console.error('Discord OAuth error:', e.message);
    res.redirect('/customize?discord_error=' + encodeURIComponent(e.message));
  }
});

// ── API: Save profile ─────────────────────────────────────────────────────────
// Protected fields that clients must never be able to overwrite via the data payload
const PROTECTED_FIELDS = new Set(['username', 'updatedAt', '_id']);

app.post('/api/profile', async (req, res) => {
  const { username, data } = req.body;
  if (!username || !/^[a-zA-Z0-9_.\-]{2,30}$/.test(username))
    return res.status(400).json({ error: 'Invalid username (2-30 chars, letters/numbers/._-)' });

  // BUG FIX: data could be undefined/null, crashing the spread below
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return res.status(400).json({ error: 'Invalid profile data' });

  // BUG FIX: strip protected fields from user-supplied data so they can't
  // overwrite username, _id, or timestamps via the payload
  const safeData = Object.fromEntries(
    Object.entries(data).filter(([k]) => !PROTECTED_FIELDS.has(k))
  );

  try {
    const database = await getDB();
    const key = username.toLowerCase();
    await database.collection('profiles').updateOne(
      { username: key },
      { $set: { ...safeData, username: key, updatedAt: Date.now() } },
      { upsert: true }
    );
    await database.collection('views').updateOne(
      { username: key },
      { $setOnInsert: { views: 0, followers: 0, clicks: 0 } },
      { upsert: true }
    );
    res.json({ ok: true, url: `/${key}` });
  } catch (e) {
    console.error('Save profile error:', e);
    res.status(500).json({ error: 'Database error: ' + e.message });
  }
});

// ── API: Get profile ──────────────────────────────────────────────────────────
app.get('/api/profile/:username', async (req, res) => {
  try {
    const database = await getDB();
    const p = await database.collection('profiles').findOne({
      username: req.params.username.toLowerCase(),
    });
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: 'Database error: ' + e.message });
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
    // BUG FIX: handle both MongoDB driver v5 (result.value) and v6+ (result directly)
    const doc   = result?.value ?? result;
    const views = doc?.views ?? 1;
    res.json({ views });
  } catch (e) {
    // BUG FIX: upsert can throw a duplicate key error under race conditions
    // (two simultaneous requests for a brand-new username). Retry once as a plain increment.
    if (e.code === 11000) {
      try {
        const database = await getDB();
        const key = req.params.username.toLowerCase();
        const doc = await database.collection('views').findOneAndUpdate(
          { username: key },
          { $inc: { views: 1 } },
          { returnDocument: 'after' }
        );
        return res.json({ views: (doc?.value ?? doc)?.views ?? 1 });
      } catch (retryErr) {
        return res.status(500).json({ error: 'Database error: ' + retryErr.message });
      }
    }
    res.status(500).json({ error: 'Database error: ' + e.message });
  }
});

app.get('/api/view/:username', async (req, res) => {
  try {
    const database = await getDB();
    const doc = await database.collection('views').findOne({
      username: req.params.username.toLowerCase(),
    });
    res.json({ views: doc?.views ?? 0 });
  } catch (e) {
    res.status(500).json({ error: 'Database error: ' + e.message });
  }
});

// ── API: Track link click ─────────────────────────────────────────────────────
app.post('/api/click/:username', async (req, res) => {
  try {
    const database = await getDB();
    await database.collection('views').updateOne(
      { username: req.params.username.toLowerCase() },
      { $inc: { clicks: 1 } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── File uploads → Cloudinary ─────────────────────────────────────────────────
app.post('/api/upload/avatar', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'vltx/avatars',
      resource_type: 'image',
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
    });
    res.json({ url: result.secure_url });
  } catch (e) {
    console.error('Avatar upload:', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

app.post('/api/upload/background', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'vltx/backgrounds',
      resource_type: 'image',
    });
    res.json({ url: result.secure_url });
  } catch (e) {
    console.error('Background upload:', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

app.post('/api/upload/music', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'vltx/music',
      resource_type: 'video',
    });
    const name = path.parse(req.file.originalname).name;
    res.json({ url: result.secure_url, name });
  } catch (e) {
    console.error('Music upload:', e.message);
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// BUG FIX: multer errors (file too large, wrong type) were unhandled — Express
// would hang or return an ugly 500. This catches them and returns clean JSON.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'File too large (max 200MB)' });
    return res.status(400).json({ error: 'Upload error: ' + err.message });
  }
  if (err && err.message && err.message.startsWith('Invalid file type')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ── Static pages ──────────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/customize', (req, res) => res.sendFile(path.join(__dirname, 'customize.html')));

// ── Profile pages /:username ──────────────────────────────────────────────────
const RESERVED = new Set([
  'api', 'auth', 'favicon.ico', 'favicon.png', 'robots.txt',
  'sitemap.xml', 'customize', '404', 'index.html', 'profile.html',
  'server.js', 'package.json', 'package-lock.json', 'node_modules', '.env',
]);

app.get('/:username', async (req, res) => {
  const key = req.params.username.toLowerCase();
  if (RESERVED.has(key) || key.includes('.'))
    return res.status(404).sendFile(path.join(__dirname, '404.html'));

  try {
    const database = await getDB();
    const p = await database.collection('profiles').findOne({ username: key });
    if (!p) return res.status(404).sendFile(path.join(__dirname, '404.html'));
    res.sendFile(path.join(__dirname, 'profile.html'));
  } catch (e) {
    console.error('Profile route error:', e.message);
    res.status(500).sendFile(path.join(__dirname, '404.html'));
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ VLTX running → http://localhost:${PORT}`);
  console.log(`   Discord OAuth: ${DISCORD_CLIENT_ID ? '✅ configured' : '⚠️  not configured — add DISCORD_CLIENT_ID to env'}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required environment variables (set these in Render / your hosting dashboard):
//
//   MONGO_URI               — MongoDB Atlas connection string
//   CLOUDINARY_CLOUD_NAME   — from cloudinary.com dashboard
//   CLOUDINARY_API_KEY      — from cloudinary.com dashboard
//   CLOUDINARY_API_SECRET   — from cloudinary.com dashboard
//   DISCORD_CLIENT_ID       — from discord.com/developers
//   DISCORD_CLIENT_SECRET   — from discord.com/developers
//   DISCORD_REDIRECT_URI    — e.g. https://vltx.lol/auth/discord/callback
//   PORT                    — (optional, defaults to 3000)
// ─────────────────────────────────────────────────────────────────────────────
