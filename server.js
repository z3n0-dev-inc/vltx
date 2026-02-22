const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const { MongoClient } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

// No dotenv needed — credentials set directly below or via hosting env vars

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Cloudinary ────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'djiebpwfn',
  api_key:    process.env.CLOUDINARY_API_KEY    || '327694518319195',
  api_secret: process.env.CLOUDINARY_API_SECRET || '1BUGv_7Y9X1JWgSKErYSVAyGtUA',
});

// ── MongoDB — single persistent client ───────────────────────────────────────
// BUG FIX: old code created a new MongoClient every cold-start and never
// reconnected if db went null. This uses one client, connects once, reuses it.
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://landenfortnite62_db_user:NvBSWNdfl7UsYdZ0@vltxlol.mace4ke.mongodb.net/?retryWrites=true&w=majority&appName=vltxlol';

const mongoClient = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 8000,
  connectTimeoutMS: 10000,
  tls: true,
  tlsAllowInvalidCertificates: false,
});
let db = null;

async function getDB() {
  if (db) return db;
  await mongoClient.connect();
  db = mongoClient.db('vltx');
  console.log('✅ MongoDB connected');
  return db;
}

// Connect eagerly so first request doesn't wait
getDB().catch(e => console.error('⚠️  MongoDB initial connect failed:', e.message));

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
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
app.use(express.static(__dirname));

// ── Discord OAuth ─────────────────────────────────────────────────────────────
// Setup steps:
//  1. Go to discord.com/developers → New Application → OAuth2
//  2. Add redirect: https://vltx.lol/auth/discord/callback
//  3. Copy Client ID + Client Secret into .env (see bottom of this file)
//  4. Scopes needed: identify

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI  || 'https://vltx-adoe.onrender.com/auth/discord/callback';

// Step 1 — user hits this → gets redirected to Discord login
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(503).send([
      '<h2 style="font-family:monospace">Discord OAuth not configured</h2>',
      '<p style="font-family:monospace">Add DISCORD_CLIENT_ID to your .env file</p>',
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

    // Build avatar URL
    const hash = user.avatar;
    const avatarUrl = hash
      ? `https://cdn.discordapp.com/avatars/${user.id}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=256`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator || '0') % 5}.png`;

    // Redirect back to customize with user data in query params
    // customize.html reads these on page load and auto-fills Discord section
    const returnTo = state && state.startsWith('/') ? state : '/customize';
    const params = new URLSearchParams({
      discord_id:       user.id,
      discord_username: user.global_name || user.username,
      discord_avatar:   avatarUrl,
      discord_tag:      user.discriminator && user.discriminator !== '0'
                          ? `#${user.discriminator}` : `@${user.username}`,
    });
    res.redirect(`${returnTo}?${params}`);

  } catch (e) {
    console.error('Discord OAuth error:', e.message);
    res.redirect('/customize?discord_error=' + encodeURIComponent(e.message));
  }
});

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
// BUG FIX: MongoDB driver v6+ returns the doc directly from findOneAndUpdate.
// Old code did result.views which was undefined — driver used to wrap it in
// result.value. Now we handle both for safety.
app.post('/api/view/:username', async (req, res) => {
  try {
    const database = await getDB();
    const key = req.params.username.toLowerCase();
    const result = await database.collection('views').findOneAndUpdate(
      { username: key },
      { $inc: { views: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    // Driver v6+: result is the doc. Driver v5: result.value is the doc.
    const doc    = result?.value ?? result;
    const views  = doc?.views ?? 1;
    res.json({ views });
  } catch (e) {
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

// ── Static pages ──────────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/customize', (req, res) => res.sendFile(path.join(__dirname, 'customize.html')));

// ── Profile pages /:username ──────────────────────────────────────────────────
// BUG FIX: old RESERVED array used .some(r => key.startsWith(r)) which means
// any username starting with e.g. "api" would 404. Now uses an exact Set lookup
// and also blocks filenames with dots (e.g. favicon.ico, server.js).
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ VLTX running → http://localhost:${PORT}`);
  console.log(`   Discord OAuth: ${DISCORD_CLIENT_ID ? '✅ configured' : '⚠️  not configured — add DISCORD_CLIENT_ID to .env'}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// .env FILE — create this in your project root (same folder as server.js)
// Never commit this file to git. Add .env to your .gitignore.
// ─────────────────────────────────────────────────────────────────────────────
//
// PORT=3000
// MONGO_URI=mongodb+srv://...your URI...
// CLOUDINARY_CLOUD_NAME=djiebpwfn
// CLOUDINARY_API_KEY=327694518319195
// CLOUDINARY_API_SECRET=1BUGv_7Y9X1JWgSKErYSVAyGtUA
//
// # Discord OAuth — get from discord.com/developers
// DISCORD_CLIENT_ID=your_client_id_here
// DISCORD_CLIENT_SECRET=your_client_secret_here
// DISCORD_REDIRECT_URI=https://vltx.lol/auth/discord/callback
//
