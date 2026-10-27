// Class Portfolio server — zero dependencies, needs Node 18+.
// Run:  node server.js     then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Zero-dependency .env loader
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
} catch {}

const { isAuthorizedEmail, normalize: normalizeEmail, ACCESS_DENIED_MESSAGE } = require('./public/email-rule.js');

const PORT = process.env.PORT || 3000;
const MAX_STUDENTS = 29;
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_DAYS = 30;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const TOKENINFO_URL = process.env.TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo';
const allowPasswordAuth = process.env.ALLOW_PASSWORD_LOGIN === '1' && !GOOGLE_CLIENT_ID;

const PRE_MADE_EMAILS = [
  'thrishank.kumar.s.129@kalvium.community',
  'lohith.m.s.129@kalvium.community',
  'pravin.kumar.s.129@kalvium.community',
];

function nameFromEmail(email) {
  const local = (email || '').split('.s.129@')[0] || (email || '').split('@')[0];
  return local
    .split('.')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

function usernameFromEmail(email) {
  const local = (email || '').split('.s.129@')[0] || (email || '').split('@')[0];
  let base = local.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 20);
  if (base.length < 3) base = (base + '___').slice(0, 3);
  return base;
}

function allocateUsername(email) {
  const base = usernameFromEmail(email);
  let candidate = base;
  let counter = 2;
  while (db.users[candidate] && db.users[candidate].email !== email) {
    const suffix = String(counter++);
    candidate = (base.slice(0, 20 - suffix.length) + suffix);
  }
  return candidate;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, sessions: {} };
let lastMtime = 0;

function seedPreMadeAccounts() {
  let changed = false;
  for (const email of PRE_MADE_EMAILS) {
    const exists = Object.values(db.users).some((u) => u.email === email);
    if (exists) continue;
    if (Object.keys(db.users).length >= MAX_STUDENTS) break;
    const username = allocateUsername(email);
    const name = nameFromEmail(email);
    db.users[username] = {
      username,
      name,
      email,
      googleId: null,
      salt: '',
      hash: '',
      tagline: '',
      role: '',
      bio: '',
      skills: [],
      links: { github: '', linkedin: '', website: '', instagram: '', email: '' },
      projects: [],
      theme: 0,
      avatar: '',
      created: Date.now(),
      updated: Date.now(),
    };
    changed = true;
  }
  if (changed) save();
}

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const stat = fs.statSync(DB_FILE);
    if (stat.mtimeMs > lastMtime) {
      const fresh = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      fresh.users ??= {};
      fresh.sessions ??= {};
      db = fresh;
      lastMtime = stat.mtimeMs;
      seedPreMadeAccounts();
    }
  } catch {}
}
loadDb();
seedPreMadeAccounts();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  try { lastMtime = fs.statSync(DB_FILE).mtimeMs; } catch {}
}

/* ---------- helpers ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(pw, user) {
  const { hash } = hashPassword(pw, user.salt);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const fail = (status, error) => Object.assign(new Error(error), { status });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1.5e6) { reject(fail(413, 'That upload is too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch { reject(fail(400, 'Bad request')); }
    });
  });
}

function currentUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = db.sessions[sha(m[1])];
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.u] || null;
}
function startSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { u: username, exp: Date.now() + SESSION_DAYS * 864e5 };
  save();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function endSession(req, res) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m) { delete db.sessions[sha(m[1])]; save(); }
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

// very small brute-force guard: 20 auth attempts / 10 min / IP
const attempts = new Map();
function rateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 600e3);
  list.push(now); attempts.set(ip, list);
  if (list.length > 20) throw fail(429, 'Too many tries. Wait a few minutes.');
}

/* ---------- profile shaping / sanitising ---------- */
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const httpUrl = (v) => {
  const s = str(v, 300); if (!s) return '';
  const u = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
};
const email = (v) => { const s = str(v, 120); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''; };

function sanitizeProfile(b) {
  const links = b.links || {};
  const out = {
    name: str(b.name, 40),
    tagline: str(b.tagline, 80),
    role: str(b.role, 40),
    bio: str(b.bio, 600),
    skills: (Array.isArray(b.skills) ? b.skills : []).map((s) => str(s, 24)).filter(Boolean).slice(0, 12),
    links: {
      github: httpUrl(links.github), linkedin: httpUrl(links.linkedin),
      website: httpUrl(links.website), instagram: httpUrl(links.instagram),
      email: email(links.email),
    },
    projects: (Array.isArray(b.projects) ? b.projects : []).slice(0, 6).map((p) => {
      let image = '';
      if (typeof p?.image === 'string' && p.image) {
        if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image) && p.image.length < 220e3) {
          image = p.image;
        }
      }
      return {
        title: str(p?.title, 60),
        desc: str(p?.desc, 240),
        url: httpUrl(p?.url),
        image,
      };
    }).filter((p) => p.title),
    theme: Number.isInteger(b.theme) && b.theme >= 0 && b.theme <= 5 ? b.theme : 0,
  };
  if (!out.name) throw fail(400, 'Your name can’t be empty');
  if (typeof b.avatar === 'string') {
    if (b.avatar === '') out.avatar = '';
    else if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.avatar) && b.avatar.length < 300e3) out.avatar = b.avatar;
    else throw fail(400, 'That image didn’t work. Try a smaller one.');
  }
  return out;
}

function ordered() {
  return Object.values(db.users).sort((a, b) => a.created - b.created);
}
function publicProfile(u, n) {
  return {
    n, username: u.username, name: u.name, tagline: u.tagline, role: u.role, bio: u.bio,
    skills: u.skills, links: u.links, projects: u.projects, theme: u.theme,
    hasAvatar: !!u.avatar, v: u.updated,
  };
}

/* ---------- Google Auth ---------- */
async function verifyGoogle(credential) {
  if (!credential || typeof credential !== 'string') {
    throw fail(400, 'Missing Google credential');
  }

  // Local development fallback when GOOGLE_CLIENT_ID is not configured
  if (!GOOGLE_CLIENT_ID && credential.startsWith('dev:')) {
    const rawEmail = credential.slice(4).trim();
    const email = normalizeEmail(rawEmail);
    if (!isAuthorizedEmail(email)) {
      throw fail(403, ACCESS_DENIED_MESSAGE);
    }
    return {
      sub: 'dev-' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 16),
      email,
      name: nameFromEmail(email),
      picture: '',
    };
  }

  const tokeninfoUrl = `${TOKENINFO_URL}?id_token=${encodeURIComponent(credential)}`;
  let resp;
  try {
    resp = await fetch(tokeninfoUrl);
  } catch (err) {
    throw fail(502, 'Could not reach Google token verification service');
  }
  if (!resp.ok) {
    throw fail(401, 'Invalid Google token');
  }
  const payload = await resp.json().catch(() => ({}));

  if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
    throw fail(401, 'Token audience does not match GOOGLE_CLIENT_ID');
  }
  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw fail(401, 'Google email is not verified');
  }

  const rawEmail = payload.email || '';
  const email = normalizeEmail(rawEmail);
  if (!isAuthorizedEmail(email)) {
    throw fail(403, ACCESS_DENIED_MESSAGE);
  }

  return {
    sub: payload.sub,
    email,
    name: payload.name || nameFromEmail(email),
    picture: payload.picture || '',
  };
}

/* ---------- API ---------- */
async function api(req, res, url) {
  loadDb();
  const route = url.pathname.slice(4); // strip /api
  const method = req.method;
  const me = currentUser(req);

  if (method !== 'GET' && !req.headers['x-req']) throw fail(403, 'Blocked');

  if (method === 'GET' && route === '/me') {
    return send(res, 200, {
      me: me ? { username: me.username, name: me.name } : null,
      max: MAX_STUDENTS,
      googleClientId: GOOGLE_CLIENT_ID || null,
      allowPasswordLogin: allowPasswordAuth,
    });
  }

  if (method === 'GET' && route === '/students') {
    return send(res, 200, { max: MAX_STUDENTS, students: ordered().map((u, i) => publicProfile(u, i + 1)) });
  }

  let m;
  if (method === 'GET' && (m = /^\/students\/([a-z0-9_]{3,20})$/.exec(route))) {
    const list = ordered(); const i = list.findIndex((u) => u.username === m[1]);
    if (i < 0) throw fail(404, 'No such student');
    return send(res, 200, {
      student: publicProfile(list[i], i + 1),
      prev: list.length > 1 ? list[(i - 1 + list.length) % list.length].username : null,
      next: list.length > 1 ? list[(i + 1) % list.length].username : null,
      nextName: list.length > 1 ? list[(i + 1) % list.length].name : null,
    });
  }

  if (method === 'GET' && (m = /^\/avatar\/([a-z0-9_]{3,20})$/.exec(route))) {
    const u = db.users[m[1]];
    const mm = u?.avatar && /^data:(image\/\w+);base64,(.+)$/.exec(u.avatar);
    if (!mm) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': mm[1], 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(Buffer.from(mm[2], 'base64'));
  }

  if (method === 'POST' && route === '/google') {
    rateLimit(req);
    const b = await readBody(req);
    const credential = typeof b.credential === 'string' ? b.credential.trim() : '';
    const gUser = await verifyGoogle(credential);

    // Look for existing user by linked googleId
    let user = Object.values(db.users).find((u) => u.googleId === gUser.sub);

    // If not found, match by verified email (e.g. pre-made account)
    if (!user) {
      user = Object.values(db.users).find((u) => u.email === gUser.email && !u.googleId);
      if (user) {
        user.googleId = gUser.sub;
        user.updated = Date.now();
        save();
      }
    }

    // If still not found, create a new student account
    if (!user) {
      if (Object.keys(db.users).length >= MAX_STUDENTS) {
        throw fail(403, 'All ' + MAX_STUDENTS + ' spots are taken');
      }
      const username = allocateUsername(gUser.email);
      user = {
        username,
        name: gUser.name || nameFromEmail(gUser.email),
        email: gUser.email,
        googleId: gUser.sub,
        salt: '',
        hash: '',
        tagline: '',
        role: '',
        bio: '',
        skills: [],
        links: { github: '', linkedin: '', website: '', instagram: '', email: '' },
        projects: [],
        theme: 0,
        avatar: '',
        created: Date.now(),
        updated: Date.now(),
      };
      db.users[username] = user;
      save();
    }

    startSession(res, user.username);
    return send(res, 200, { me: { username: user.username, name: user.name } });
  }

  if (method === 'POST' && route === '/signup') {
    if (!allowPasswordAuth) throw fail(403, 'Password registration is disabled');
    rateLimit(req);
    const b = await readBody(req);
    const username = str(b.username, 20).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    const name = str(b.name, 40);
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw fail(400, 'User ID: 3–20 letters, numbers or _');
    if (password.length < 6 || password.length > 100) throw fail(400, 'Password needs at least 6 characters');
    if (!name) throw fail(400, 'Tell us your name');
    if (db.users[username]) throw fail(409, 'That user ID is taken');
    if (Object.keys(db.users).length >= MAX_STUDENTS) throw fail(403, 'All ' + MAX_STUDENTS + ' spots are taken');
    const { salt, hash } = hashPassword(password);
    db.users[username] = {
      username, name, salt, hash, tagline: '', role: '', bio: '', skills: [],
      links: { github: '', linkedin: '', website: '', instagram: '', email: '' },
      projects: [], theme: 0, avatar: '', created: Date.now(), updated: Date.now(),
    };
    save();
    startSession(res, username);
    return send(res, 200, { me: { username, name } });
  }

  if (method === 'POST' && route === '/login') {
    if (!allowPasswordAuth) throw fail(403, 'Password login is disabled');
    rateLimit(req);
    const b = await readBody(req);
    const u = db.users[str(b.username, 20).toLowerCase()];
    // run the hash either way so timing doesn't reveal which IDs exist
    const ok = u ? checkPassword(String(b.password || ''), u) : (hashPassword('x'), false);
    if (!ok) throw fail(401, 'Wrong user ID or password');
    startSession(res, u.username);
    return send(res, 200, { me: { username: u.username, name: u.name } });
  }

  if (method === 'POST' && route === '/logout') {
    endSession(req, res);
    return send(res, 200, { ok: true });
  }

  // everything below needs a login, and ONLY ever touches the logged-in user's own record
  if (!me) throw fail(401, 'Log in first');

  if (method === 'GET' && route === '/profile') {
    return send(res, 200, { profile: publicProfile(me, ordered().findIndex((u) => u.username === me.username) + 1) });
  }

  if (method === 'PUT' && route === '/profile') {
    const clean = sanitizeProfile(await readBody(req));
    Object.assign(me, clean, { updated: Date.now() });
    save();
    return send(res, 200, { profile: publicProfile(me, ordered().findIndex((u) => u.username === me.username) + 1), me: { username: me.username, name: me.name } });
  }

  if (method === 'DELETE' && route === '/account') {
    delete db.users[me.username];
    for (const k of Object.keys(db.sessions)) if (db.sessions[k].u === me.username) delete db.sessions[k];
    save();
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
    return send(res, 200, { ok: true });
  }

  throw fail(404, 'Not found');
}

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
  }
}).listen(PORT, () => console.log(`\n  Class portfolio running → http://localhost:${PORT}\n`));
