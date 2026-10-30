// Class Portfolio server — Node 18+
// Zero external dependencies in core runtime除了 pg & aws-sdk
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Zero-dependency .env & .env.local loader
function loadEnvFile(filename) {
  try {
    const envPath = path.join(__dirname, filename);
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
}
loadEnvFile('.env.local');
loadEnvFile('.env');

const db = require('./db.js');
const storage = require('./storage.js');
const { generateResumePdf } = require('./pdf.js');
const { isAuthorizedEmail, normalize: normalizeEmail, ACCESS_DENIED_MESSAGE } = require('./public/email-rule.js');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const getMaxStudents = () => parseInt(process.env.MAX_STUDENTS, 10) || 30;
const PUBLIC = path.join(__dirname, 'public');
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

async function allocateUsername(email) {
  const base = usernameFromEmail(email);
  let candidate = base;
  let counter = 2;
  while (true) {
    const existing = await db.query('SELECT email FROM users WHERE username = $1', [candidate]);
    if (existing.rows.length === 0 || existing.rows[0].email === email) {
      return candidate;
    }
    const suffix = String(counter++);
    candidate = (base.slice(0, 20 - suffix.length) + suffix);
  }
}

async function seedPreMadeAccounts() {
  for (const em of PRE_MADE_EMAILS) {
    const existing = await db.query('SELECT username FROM users WHERE email = $1', [em]);
    if (existing.rows.length > 0) continue;

    const countRes = await db.query('SELECT count(*) FROM users');
    if (parseInt(countRes.rows[0].count, 10) >= getMaxStudents()) break;

    const username = await allocateUsername(em);
    const name = nameFromEmail(em);
    const now = Date.now();
    await db.query(`
      INSERT INTO users (
        username, name, email, sub, tagline, role, bio,
        skills, links, projects, theme, resume_public, created, updated
      )
      VALUES ($1, $2, $3, NULL, '', '', '', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0, false, $4, $5)
      ON CONFLICT (username) DO NOTHING
    `, [username, name, em, now, now]);
  }
}

// Server initialization promise
let dbReady = (async () => {
  try {
    await db.runMigrations();
    await seedPreMadeAccounts();
    db.startSessionCleanup();
    // Verify object storage buckets if S3 configured
    storage.ensureBucketsExist().catch(() => {});
  } catch (err) {
    console.error('[init] Database initialization error:', err);
    throw err;
  }
})();

/* ---------- helpers ---------- */
let signupQueue = Promise.resolve();
function withSignupLock(fn) {
  const next = signupQueue.then(fn, fn);
  signupQueue = next.catch(() => {});
  return next;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(pw, user) {
  if (!user.salt || !user.hash) return false;
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

async function currentUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const tokenHash = sha(m[1]);
  const res = await db.query(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON s.username = u.username
    WHERE s.token_hash = $1 AND s.expires_at > NOW()
  `, [tokenHash]);
  if (res.rows.length === 0) return null;
  return res.rows[0];
}

async function startSession(res, username) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.query(`
    INSERT INTO sessions (token_hash, username, expires_at)
    VALUES ($1, $2, $3)
  `, [tokenHash, username, expiresAt]);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

async function endSession(req, res) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (m) {
    const tokenHash = sha(m[1]);
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

// very small brute-force guard: 20 auth attempts / 10 min / IP
const attempts = new Map();
function rateLimit(req) {
  if (process.env.NODE_ENV === 'test') return;
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
    phone: str(b.phone, 30),
    location: str(b.location, 100),
    skills: (Array.isArray(b.skills) ? b.skills : []).map((s) => str(s, 24)).filter(Boolean).slice(0, 12),
    links: {
      github: httpUrl(links.github), linkedin: httpUrl(links.linkedin),
      website: httpUrl(links.website), instagram: httpUrl(links.instagram),
      email: email(links.email),
    },
    projects: (Array.isArray(b.projects) ? b.projects : []).slice(0, 6).map((p) => {
      let image = '';
      if (typeof p?.image === 'string' && p.image) {
        if (httpUrl(p.image) || p.image.startsWith('/api/files/') || (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.image) && p.image.length < 220e3)) {
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
    education: (Array.isArray(b.education) ? b.education : []).slice(0, 6).map((e) => ({
      school: str(e?.school, 100),
      degree: str(e?.degree, 80),
      field: str(e?.field, 80),
      start_year: str(e?.start_year, 20),
      end_year: str(e?.end_year, 20),
    })).filter((e) => e.school || e.degree),
    experience: (Array.isArray(b.experience) ? b.experience : []).slice(0, 8).map((exp) => ({
      title: str(exp?.title, 80),
      organisation: str(exp?.organisation, 100),
      start: str(exp?.start, 30),
      end: str(exp?.end, 30),
      description: str(exp?.description, 400),
    })).filter((exp) => exp.title || exp.organisation),
    achievements: (Array.isArray(b.achievements) ? b.achievements : []).map((a) => str(a, 140)).filter(Boolean).slice(0, 10),
    certifications: (Array.isArray(b.certifications) ? b.certifications : []).slice(0, 10).map((c) => ({
      name: str(c?.name, 100),
      issuer: str(c?.issuer, 100),
      year: str(c?.year, 20),
    })).filter((c) => c.name),
    theme: Number.isInteger(b.theme) && b.theme >= 0 && b.theme <= 5 ? b.theme : 0,
    resume_public: Boolean(b.resume_public),
  };
  if (!out.name) throw fail(400, 'Your name can’t be empty');
  return out;
}

function parseJsonField(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function publicProfile(u, n, hasAvatar = false, hasResume = false, isOwner = false) {
  const prof = {
    n,
    username: u.username,
    name: u.name,
    tagline: u.tagline || '',
    role: u.role || '',
    bio: u.bio || '',
    location: u.location || '',
    skills: parseJsonField(u.skills, []),
    links: parseJsonField(u.links, {}),
    projects: parseJsonField(u.projects, []),
    education: parseJsonField(u.education, []),
    experience: parseJsonField(u.experience, []),
    achievements: parseJsonField(u.achievements, []),
    certifications: parseJsonField(u.certifications, []),
    theme: u.theme || 0,
    hasAvatar: Boolean(hasAvatar),
    hasResume: Boolean(hasResume),
    resumePublic: Boolean(u.resume_public),
    v: u.updated || u.created,
  };
  // Phone is NEVER shown publicly or on the public profile; it only appears to the owner (e.g. editor) or on downloaded resume
  if (isOwner) {
    prof.phone = u.phone || '';
  }
  return prof;
}

/* ---------- Google Auth ---------- */
async function verifyGoogle(credential) {
  if (!credential || typeof credential !== 'string') {
    throw fail(400, 'Missing Google credential');
  }

  // Local development fallback or test environment
  if ((!GOOGLE_CLIENT_ID || process.env.NODE_ENV === 'test') && credential.startsWith('dev:')) {
    const rawEmail = credential.slice(4).trim();
    const em = normalizeEmail(rawEmail);
    if (!isAuthorizedEmail(em)) {
      throw fail(403, ACCESS_DENIED_MESSAGE);
    }
    return {
      sub: 'dev-' + crypto.createHash('sha256').update(em).digest('hex').slice(0, 16),
      email: em,
      name: nameFromEmail(em),
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
  const em = normalizeEmail(rawEmail);
  if (!isAuthorizedEmail(em)) {
    throw fail(403, ACCESS_DENIED_MESSAGE);
  }

  return {
    sub: payload.sub,
    email: em,
    name: payload.name || nameFromEmail(em),
    picture: payload.picture || '',
  };
}

/* ---------- API ---------- */
async function api(req, res, url) {
  await dbReady;
  const route = url.pathname.slice(4); // strip /api
  const method = req.method;
  const me = await currentUser(req);

  if (method !== 'GET' && !req.headers['x-req']) throw fail(403, 'Blocked');

  if (method === 'GET' && route === '/me') {
    return send(res, 200, {
      me: me ? { username: me.username, name: me.name } : null,
      max: getMaxStudents(),
      googleClientId: GOOGLE_CLIENT_ID || null,
      allowPasswordLogin: allowPasswordAuth,
    });
  }

  // GET /api/students — paginated & searchable
  if (method === 'GET' && route === '/students') {
    const defaultLimit = Math.max(30, getMaxStudents());
    const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || String(defaultLimit), 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));
    const q = (url.searchParams.get('q') || '').trim();

    const countRes = await db.query('SELECT count(*) FROM users');
    const totalCount = parseInt(countRes.rows[0].count, 10);

    let querySql;
    let queryParams;
    let filteredCount = totalCount;

    if (q) {
      const term = `%${q.toLowerCase()}%`;
      const filterCountRes = await db.query(`
        SELECT count(*) FROM users
        WHERE LOWER(name) LIKE $1 OR LOWER(role) LIKE $1 OR LOWER(skills::text) LIKE $1
      `, [term]);
      filteredCount = parseInt(filterCountRes.rows[0].count, 10);

      querySql = `
        SELECT
          u.username, u.name, u.tagline, u.role, u.skills, u.theme, u.updated, u.created,
          f.id IS NOT NULL as has_avatar
        FROM users u
        LEFT JOIN files f ON f.username = u.username AND f.kind = 'avatar'
        WHERE LOWER(u.name) LIKE $1 OR LOWER(u.role) LIKE $1 OR LOWER(u.skills::text) LIKE $1
        ORDER BY u.created ASC
        LIMIT $2 OFFSET $3
      `;
      queryParams = [term, limit, offset];
    } else {
      querySql = `
        SELECT
          u.username, u.name, u.tagline, u.role, u.skills, u.theme, u.updated, u.created,
          f.id IS NOT NULL as has_avatar
        FROM users u
        LEFT JOIN files f ON f.username = u.username AND f.kind = 'avatar'
        ORDER BY u.created ASC
        LIMIT $1 OFFSET $2
      `;
      queryParams = [limit, offset];
    }

    const studentsRes = await db.query(querySql, queryParams);
    const students = studentsRes.rows.map((u, i) => ({
      n: offset + i + 1,
      username: u.username,
      name: u.name,
      tagline: u.tagline || '',
      role: u.role || '',
      skills: parseJsonField(u.skills, []),
      theme: u.theme || 0,
      hasAvatar: Boolean(u.has_avatar),
      v: u.updated || u.created,
    }));

    return send(res, 200, {
      max: getMaxStudents(),
      count: totalCount,
      total: filteredCount,
      students,
    });
  }

  let m;
  // GET /api/students/:username
  if (method === 'GET' && (m = /^\/students\/([a-z0-9_]{3,20})$/.exec(route))) {
    const targetUsername = m[1];
    const uRes = await db.query('SELECT * FROM users WHERE username = $1', [targetUsername]);
    if (uRes.rows.length === 0) throw fail(404, 'No such student');
    const u = uRes.rows[0];

    const fRes = await db.query('SELECT kind FROM files WHERE username = $1', [targetUsername]);
    const fileKinds = new Set(fRes.rows.map((r) => r.kind));
    const hasAvatar = fileKinds.has('avatar');
    const hasResume = fileKinds.has('resume');

    // Compute student's position n
    const posRes = await db.query('SELECT count(*) FROM users WHERE created <= $1', [u.created]);
    const n = parseInt(posRes.rows[0].count, 10);

    // Compute circular next / prev
    const orderRes = await db.query('SELECT username, name FROM users ORDER BY created ASC');
    const list = orderRes.rows;
    const idx = list.findIndex((row) => row.username === u.username);

    const prev = list.length > 1 ? list[(idx - 1 + list.length) % list.length].username : null;
    const next = list.length > 1 ? list[(idx + 1) % list.length].username : null;
    const nextName = list.length > 1 ? list[(idx + 1) % list.length].name : null;

    return send(res, 200, {
      student: publicProfile(u, n, hasAvatar, hasResume, me && me.username === u.username),
      prev,
      next,
      nextName,
    });
  }

  // GET /api/avatar/:username — redirect to file URL
  if (method === 'GET' && (m = /^\/avatar\/([a-z0-9_]{3,20})$/.exec(route))) {
    const targetUsername = m[1];
    const fRes = await db.query(`
      SELECT storage_key FROM files
      WHERE username = $1 AND kind = 'avatar'
      LIMIT 1
    `, [targetUsername]);

    if (fRes.rows.length === 0) {
      res.writeHead(404);
      return res.end();
    }

    const publicUrl = storage.getPublicUrl(fRes.rows[0].storage_key);
    res.writeHead(302, {
      'Location': publicUrl,
      'Cache-Control': 'public, max-age=3600',
    });
    return res.end();
  }

  // GET /api/resume/auto — current user's auto-generated resume PDF
  if (method === 'GET' && route === '/resume/auto') {
    if (!me) throw fail(401, 'Log in first');
    const template = url.searchParams.get('template') || 'classic';
    const isInline = url.searchParams.get('preview') === '1' || url.searchParams.get('inline') === '1';

    // Fetch fresh user record from DB to guarantee latest edits
    const uRes = await db.query('SELECT * FROM users WHERE username = $1', [me.username]);
    if (uRes.rows.length === 0) throw fail(404, 'User not found');
    const u = uRes.rows[0];

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const baseUrl = `${proto}://${host}`;

    const pdfBuffer = await generateResumePdf({
      username: u.username,
      name: u.name,
      role: u.role,
      bio: u.bio,
      phone: u.phone,
      location: u.location,
      skills: parseJsonField(u.skills, []),
      links: parseJsonField(u.links, {}),
      projects: parseJsonField(u.projects, []),
      education: parseJsonField(u.education, []),
      experience: parseJsonField(u.experience, []),
      achievements: parseJsonField(u.achievements, []),
      certifications: parseJsonField(u.certifications, []),
      theme: u.theme,
    }, { template, baseUrl });

    const safeName = (u.name || 'Resume').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeName}-Resume.pdf`;
    const disposition = isInline ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`;

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      'Content-Length': pdfBuffer.length,
    });
    return res.end(pdfBuffer);
  }

  // GET /api/resume/auto/:username — student's auto-generated resume PDF
  if (method === 'GET' && (m = /^\/resume\/auto\/([a-z0-9_]{3,20})$/.exec(route))) {
    const targetUsername = m[1];
    const uRes = await db.query('SELECT * FROM users WHERE username = $1', [targetUsername]);
    if (uRes.rows.length === 0) throw fail(404, 'No such student');
    const targetUser = uRes.rows[0];

    const isOwner = me && me.username === targetUsername;
    const isPublicAllowed = Boolean(targetUser.resume_public);

    if (!isOwner && !isPublicAllowed) {
      throw fail(403, 'This resume is private');
    }

    const template = url.searchParams.get('template') || 'classic';
    const isInline = url.searchParams.get('preview') === '1' || url.searchParams.get('inline') === '1';

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const baseUrl = `${proto}://${host}`;

    // Phone is NEVER included on public views
    const phone = isOwner ? targetUser.phone : '';

    const pdfBuffer = await generateResumePdf({
      username: targetUser.username,
      name: targetUser.name,
      role: targetUser.role,
      bio: targetUser.bio,
      phone,
      location: targetUser.location,
      skills: parseJsonField(targetUser.skills, []),
      links: parseJsonField(targetUser.links, {}),
      projects: parseJsonField(targetUser.projects, []),
      education: parseJsonField(targetUser.education, []),
      experience: parseJsonField(targetUser.experience, []),
      achievements: parseJsonField(targetUser.achievements, []),
      certifications: parseJsonField(targetUser.certifications, []),
      theme: targetUser.theme,
    }, { template, baseUrl });

    const safeName = (targetUser.name || 'Resume').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeName}-Resume.pdf`;
    const disposition = isInline ? `inline; filename="${filename}"` : `attachment; filename="${filename}"`;

    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      'Content-Length': pdfBuffer.length,
    });
    return res.end(pdfBuffer);
  }

  // GET /api/resume/:username — presigned download redirect
  if (method === 'GET' && (m = /^\/resume\/([a-z0-9_]{3,20})$/.exec(route))) {
    const targetUsername = m[1];
    const uRes = await db.query('SELECT username, resume_public FROM users WHERE username = $1', [targetUsername]);
    if (uRes.rows.length === 0) throw fail(404, 'No such student');
    const targetUser = uRes.rows[0];

    // Check permission: owner can always access; other students can only access if resume_public is true and logged in
    const isOwner = me && me.username === targetUsername;
    const isPublicAllowed = targetUser.resume_public && me !== null;

    if (!isOwner && !isPublicAllowed) {
      throw fail(403, 'This resume is private');
    }

    const fRes = await db.query(`
      SELECT bucket, storage_key FROM files
      WHERE username = $1 AND kind = 'resume'
      LIMIT 1
    `, [targetUsername]);

    if (fRes.rows.length === 0) throw fail(404, 'No resume found for this student');

    const downloadUrl = await storage.getPresignedDownloadUrl(fRes.rows[0].bucket, fRes.rows[0].storage_key, 300);

    if (url.searchParams.get('json') === '1' || req.headers.accept?.includes('application/json')) {
      return send(res, 200, { url: downloadUrl });
    }

    res.writeHead(302, { 'Location': downloadUrl, 'Cache-Control': 'no-store' });
    return res.end();
  }

  // POST /api/google
  if (method === 'POST' && route === '/google') {
    rateLimit(req);
    const b = await readBody(req);
    const credential = typeof b.credential === 'string' ? b.credential.trim() : '';
    const gUser = await verifyGoogle(credential);

    const user = await withSignupLock(async () => {
      return await db.withTransaction(async (client) => {
        // 1. Look for existing user by linked sub
        let uRes = await client.query('SELECT * FROM users WHERE sub = $1', [gUser.sub]);
        if (uRes.rows.length > 0) return uRes.rows[0];

        // 2. Match by email where sub is null (pre-made account)
        uRes = await client.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND (sub IS NULL OR COALESCE(sub, '') = '')", [gUser.email]);
        if (uRes.rows.length > 0) {
          const u = uRes.rows[0];
          await client.query('UPDATE users SET sub = $1, updated = $2 WHERE username = $3', [gUser.sub, Date.now(), u.username]);
          u.sub = gUser.sub;
          return u;
        }

        // 3. Otherwise, check student cap inside transaction
        const countRes = await client.query('SELECT count(*) FROM users');
        const count = parseInt(countRes.rows[0].count, 10);
        const cap = getMaxStudents();
        if (count >= cap) {
          throw fail(403, 'All ' + cap + ' spots are taken');
        }

        // Allocate username and create user
        const username = await allocateUsername(gUser.email);
        const name = gUser.name || nameFromEmail(gUser.email);
        const now = Date.now();

        await client.query(`
          INSERT INTO users (
            username, name, email, sub, tagline, role, bio,
            skills, links, projects, theme, resume_public, created, updated
          )
          VALUES ($1, $2, $3, $4, '', '', '', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0, false, $5, $6)
        `, [username, name, gUser.email, gUser.sub, now, now]);

        return { username, name, email: gUser.email, sub: gUser.sub };
      });
    });

    await startSession(res, user.username);
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

    await withSignupLock(async () => {
      await db.withTransaction(async (client) => {
        const exist = await client.query('SELECT username FROM users WHERE username = $1', [username]);
        if (exist.rows.length > 0) throw fail(409, 'That user ID is taken');

        const countRes = await client.query('SELECT count(*) FROM users');
        const cap = getMaxStudents();
        if (parseInt(countRes.rows[0].count, 10) >= cap) {
          throw fail(403, 'All ' + cap + ' spots are taken');
        }

        const { salt, hash } = hashPassword(password);
        const now = Date.now();
        await client.query(`
          INSERT INTO users (
            username, name, tagline, role, bio,
            skills, links, projects, theme, resume_public, created, updated
          )
          VALUES ($1, $2, '', '', '', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0, false, $3, $4)
        `, [username, name, now, now]);
      });
    });

    await startSession(res, username);
    return send(res, 200, { me: { username, name } });
  }

  if (method === 'POST' && route === '/login') {
    if (!allowPasswordAuth) throw fail(403, 'Password login is disabled');
    rateLimit(req);
    const b = await readBody(req);
    const uRes = await db.query('SELECT * FROM users WHERE username = $1', [str(b.username, 20).toLowerCase()]);
    const u = uRes.rows[0];
    const ok = u ? checkPassword(String(b.password || ''), u) : (hashPassword('x'), false);
    if (!ok) throw fail(401, 'Wrong user ID or password');
    await startSession(res, u.username);
    return send(res, 200, { me: { username: u.username, name: u.name } });
  }

  if (method === 'POST' && route === '/logout') {
    await endSession(req, res);
    return send(res, 200, { ok: true });
  }

  // --- Endpoints below REQUIRE a valid session ---
  if (!me) throw fail(401, 'Log in first');

  if (method === 'GET' && route === '/profile') {
    const posRes = await db.query('SELECT count(*) FROM users WHERE created <= $1', [me.created]);
    const n = parseInt(posRes.rows[0].count, 10);
    const fRes = await db.query('SELECT kind FROM files WHERE username = $1', [me.username]);
    const fileKinds = new Set(fRes.rows.map((r) => r.kind));

    const uRes = await db.query('SELECT * FROM users WHERE username = $1', [me.username]);
    const freshUser = uRes.rows.length > 0 ? uRes.rows[0] : me;

    return send(res, 200, {
      profile: publicProfile(freshUser, n, fileKinds.has('avatar'), fileKinds.has('resume'), true),
    });
  }

  if (method === 'PUT' && route === '/profile') {
    const clean = sanitizeProfile(await readBody(req));
    const now = Date.now();
    await db.query(`
      UPDATE users SET
        name = $1, tagline = $2, role = $3, bio = $4,
        skills = $5, links = $6, projects = $7, theme = $8,
        resume_public = $9, phone = $10, location = $11,
        education = $12, experience = $13, achievements = $14,
        certifications = $15, updated = $16
      WHERE username = $17
    `, [
      clean.name,
      clean.tagline,
      clean.role,
      clean.bio,
      JSON.stringify(clean.skills),
      JSON.stringify(clean.links),
      JSON.stringify(clean.projects),
      clean.theme,
      clean.resume_public,
      clean.phone,
      clean.location,
      JSON.stringify(clean.education),
      JSON.stringify(clean.experience),
      JSON.stringify(clean.achievements),
      JSON.stringify(clean.certifications),
      now,
      me.username,
    ]);

    const posRes = await db.query('SELECT count(*) FROM users WHERE created <= $1', [me.created]);
    const n = parseInt(posRes.rows[0].count, 10);
    const fRes = await db.query('SELECT kind FROM files WHERE username = $1', [me.username]);
    const fileKinds = new Set(fRes.rows.map((r) => r.kind));

    const updatedUser = { ...me, ...clean, updated: now };
    return send(res, 200, {
      profile: publicProfile(updatedUser, n, fileKinds.has('avatar'), fileKinds.has('resume'), true),
      me: { username: me.username, name: clean.name },
    });
  }

  if (method === 'DELETE' && route === '/account') {
    // Delete all user files from S3 first
    const filesRes = await db.query('SELECT bucket, storage_key FROM files WHERE username = $1', [me.username]);
    for (const f of filesRes.rows) {
      await storage.deleteObject(f.bucket, f.storage_key);
    }

    // Cascade delete user row (cascades sessions & files)
    await db.query('DELETE FROM users WHERE username = $1', [me.username]);

    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
    return send(res, 200, { ok: true });
  }

  // --- S3 File Upload Flow ---
  if (method === 'POST' && route === '/files/upload-url') {
    rateLimit(req);
    const b = await readBody(req);
    const kind = str(b.kind, 20);
    const contentType = str(b.contentType, 50).toLowerCase();

    if (!['avatar', 'resume', 'project_image'].includes(kind)) {
      throw fail(400, 'Invalid file kind. Must be avatar, resume, or project_image');
    }

    if (kind === 'avatar' || kind === 'project_image') {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        throw fail(400, 'Images must be JPEG, PNG, or WebP');
      }
    } else if (kind === 'resume') {
      if (contentType !== 'application/pdf') {
        throw fail(400, 'Resumes must be PDF');
      }
    }

    // Check project image count limit (max 6)
    if (kind === 'project_image') {
      const countRes = await db.query('SELECT count(*) FROM files WHERE username = $1 AND kind = $2', [me.username, 'project_image']);
      if (parseInt(countRes.rows[0].count, 10) >= 6 && !b.replaceKey) {
        throw fail(400, 'Maximum of 6 project images reached. Please remove an existing image first.');
      }
    }

    const cfg = storage.getS3Config();
    const bucket = kind === 'resume' ? cfg.bucketPrivate : cfg.bucketPublic;

    const ext = contentType === 'application/pdf' ? 'pdf' : (contentType === 'image/jpeg' ? 'jpg' : (contentType === 'image/png' ? 'png' : 'webp'));
    const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const storageKey = `users/${me.username}/${kind}/${fileId}.${ext}`;

    const uploadUrl = await storage.getPresignedUploadUrl(bucket, storageKey, contentType, 900);

    return send(res, 200, {
      uploadUrl,
      storageKey,
      bucket,
      kind,
    });
  }

  if (method === 'POST' && route === '/files/complete') {
    rateLimit(req);
    const b = await readBody(req);
    const storageKey = str(b.storageKey, 500);
    const kind = str(b.kind, 20);

    if (!['avatar', 'resume', 'project_image'].includes(kind)) {
      throw fail(400, 'Invalid file kind');
    }

    // Server-enforced key ownership check: user can ONLY complete their OWN file
    const expectedPrefix = `users/${me.username}/${kind}/`;
    if (!storageKey.startsWith(expectedPrefix)) {
      throw fail(403, 'Unauthorized storage key for this user');
    }

    const cfg = storage.getS3Config();
    const bucket = kind === 'resume' ? cfg.bucketPrivate : cfg.bucketPublic;

    // Verify object exists in bucket via HeadObject
    let head;
    try {
      head = await storage.headObject(bucket, storageKey);
    } catch (err) {
      throw fail(400, 'Uploaded file not found in storage');
    }

    const sizeBytes = head.ContentLength || 0;
    const mime = head.ContentType || b.mime || (kind === 'resume' ? 'application/pdf' : 'image/jpeg');

    // Strict size limits
    if (kind === 'avatar' || kind === 'project_image') {
      if (sizeBytes > 1048576) {
        await storage.deleteObject(bucket, storageKey);
        throw fail(400, 'Image must be 1 MB or smaller');
      }
    } else if (kind === 'resume') {
      if (sizeBytes > 3145728) {
        await storage.deleteObject(bucket, storageKey);
        throw fail(400, 'Resume must be 3 MB or smaller');
      }
    }

    // Replacing single-item files (1 avatar, 1 resume)
    if (kind === 'avatar' || kind === 'resume') {
      const oldRes = await db.query('SELECT bucket, storage_key FROM files WHERE username = $1 AND kind = $2', [me.username, kind]);
      for (const oldFile of oldRes.rows) {
        await storage.deleteObject(oldFile.bucket, oldFile.storage_key);
      }
      await db.query('DELETE FROM files WHERE username = $1 AND kind = $2', [me.username, kind]);
    } else if (kind === 'project_image' && b.replaceKey) {
      if (b.replaceKey.startsWith(`users/${me.username}/project_image/`)) {
        await storage.deleteObject(bucket, b.replaceKey);
        await db.query('DELETE FROM files WHERE username = $1 AND storage_key = $2', [me.username, b.replaceKey]);
      }
    }

    const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const now = Date.now();

    await db.query(`
      INSERT INTO files (id, username, kind, bucket, storage_key, mime, size_bytes, created)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [fileId, me.username, kind, bucket, storageKey, mime, sizeBytes, now]);

    await db.query('UPDATE users SET updated = $1 WHERE username = $2', [now, me.username]);

    const urlOut = kind === 'resume' ? null : storage.getPublicUrl(storageKey);
    return send(res, 200, {
      ok: true,
      file: {
        id: fileId,
        kind,
        storageKey,
        url: urlOut,
        sizeBytes,
      },
    });
  }

  if (method === 'DELETE' && route === '/files') {
    const b = await readBody(req);
    const storageKey = str(b.storageKey, 500);

    const fRes = await db.query('SELECT * FROM files WHERE username = $1 AND storage_key = $2', [me.username, storageKey]);
    if (fRes.rows.length === 0) {
      throw fail(404, 'File not found or does not belong to you');
    }

    const file = fRes.rows[0];
    await storage.deleteObject(file.bucket, file.storage_key);
    await db.query('DELETE FROM files WHERE id = $1', [file.id]);
    await db.query('UPDATE users SET updated = $1 WHERE username = $2', [Date.now(), me.username]);

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

const server = http.createServer(async (req, res) => {
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
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`\n  Class portfolio running → http://localhost:${PORT}\n`));
}

module.exports = { server, dbReady };
