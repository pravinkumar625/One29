const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { newDb, DataType } = require('pg-mem');

// Configure test environment
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
delete process.env.MAX_STUDENTS;
process.env.GOOGLE_CLIENT_ID = '';

const db = require('../db.js');
const storage = require('../storage.js');
const { migrateJson } = require('../migrate-json.js');

function createMockS3() {
  const store = new Map();
  return {
    store,
    getPresignedUploadUrl: async (bucket, key) => `https://mock-storage.neon.tech/${bucket}/${key}?signed=upload`,
    getPresignedDownloadUrl: async (bucket, key) => `https://mock-storage.neon.tech/${bucket}/${key}?signed=download`,
    send: async (command) => {
      const name = command.constructor.name;
      const input = command.input || {};
      const fullKey = `${input.Bucket}:${input.Key}`;

      if (name === 'HeadBucketCommand' || name === 'CreateBucketCommand') {
        return {};
      }
      if (name === 'PutObjectCommand') {
        const bodyBuf = Buffer.isBuffer(input.Body)
          ? input.Body
          : (typeof input.Body === 'string' ? Buffer.from(input.Body) : Buffer.alloc(input.ContentLength || 100));
        store.set(fullKey, {
          Body: bodyBuf,
          ContentType: input.ContentType,
          ContentLength: input.ContentLength !== undefined ? input.ContentLength : bodyBuf.length,
        });
        return {};
      }
      if (name === 'HeadObjectCommand') {
        if (!store.has(fullKey)) {
          const err = new Error('NotFound');
          err.name = 'NotFound';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        const item = store.get(fullKey);
        return {
          ContentLength: item.ContentLength,
          ContentType: item.ContentType,
        };
      }
      if (name === 'GetObjectCommand') {
        if (!store.has(fullKey)) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return store.get(fullKey);
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(fullKey);
        return {};
      }
      return {};
    },
  };
}

function request(server, pathStr, options = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const url = new URL(pathStr, `http://127.0.0.1:${addr.port}`);
    const payload = options.body ? JSON.stringify(options.body) : null;
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: Object.assign(
        { 'X-Req': '1' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        options.cookie ? { Cookie: options.cookie } : {}
      ),
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json !== null ? json : data,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Phase 1–3 Security, Scale & Storage Tests', () => {
  let server;
  let mockS3;
  let testPool;

  before(async () => {
    // Setup fresh pg-mem
    const mem = newDb();
    mem.public.registerFunction({
      name: 'lower',
      args: [DataType.text],
      returns: DataType.text,
      implementation: (x) => (x ? x.toLowerCase() : x),
    });
    const adapter = mem.adapters.createPg();
    testPool = new adapter.Pool();
    db.setPool(testPool);

    mockS3 = createMockS3();
    storage.setS3Client(mockS3);

    const app = require('../server.js');
    await app.dbReady;

    server = app.server;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    db.stopSessionCleanup();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  describe('Security & Multi-tenant Isolation', () => {
    let aliceCookie;
    let bobCookie;

    before(async () => {
      // Create student A (Alice)
      const resA = await request(server, '/api/google', {
        method: 'POST',
        body: { credential: 'dev:alice.s.129@kalvium.community' },
      });
      assert.strictEqual(resA.status, 200, 'Alice signin failed: ' + JSON.stringify(resA.data));
      aliceCookie = resA.headers['set-cookie'][0].split(';')[0];

      // Create student B (Bob)
      const resB = await request(server, '/api/google', {
        method: 'POST',
        body: { credential: 'dev:bob.s.129@kalvium.community' },
      });
      assert.strictEqual(resB.status, 200, 'Bob signin failed: ' + JSON.stringify(resB.data));
      bobCookie = resB.headers['set-cookie'][0].split(';')[0];
    });

    it('A student cannot edit another student data; acting user always comes from session', async () => {
      // Alice tries to edit profile while passing Bob username in body
      const res = await request(server, '/api/profile', {
        method: 'PUT',
        cookie: aliceCookie,
        body: {
          username: 'bob', // Attempt to spoof target
          name: 'Hacked Bob',
          bio: 'Alice modified Bob bio',
        },
      });

      assert.strictEqual(res.status, 200);
      // The update must apply ONLY to Alice
      assert.strictEqual(res.data.me.username, 'alice');
      assert.strictEqual(res.data.profile.name, 'Hacked Bob');

      // Verify Bob profile is completely untouched
      const bobProfile = await request(server, '/api/students/bob');
      assert.strictEqual(bobProfile.status, 200);
      assert.strictEqual(bobProfile.data.student.name, 'Bob');
      assert.strictEqual(bobProfile.data.student.bio, '');

      // Restore Alice profile name
      await request(server, '/api/profile', {
        method: 'PUT',
        cookie: aliceCookie,
        body: { name: 'Alice', bio: 'Alice bio' },
      });
    });

    it('keys cannot be chosen by the client; server generates keys', async () => {
      const res = await request(server, '/api/files/upload-url', {
        method: 'POST',
        cookie: aliceCookie,
        body: {
          kind: 'avatar',
          contentType: 'image/jpeg',
          storageKey: 'users/bob/avatar/overwrite.jpg', // Client trying to choose key
        },
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.data.storageKey.startsWith('users/alice/avatar/'));
      assert.ok(!res.data.storageKey.includes('bob'));
    });

    it('A student cannot complete upload for another student key', async () => {
      // Pretend Bob file exists in S3
      const bobKey = 'users/bob/avatar/secret.jpg';
      mockS3.store.set(`public-media:${bobKey}`, {
        Body: Buffer.from('image bytes'),
        ContentType: 'image/jpeg',
        ContentLength: 100,
      });

      // Alice tries to complete Bob's storage key
      const res = await request(server, '/api/files/complete', {
        method: 'POST',
        cookie: aliceCookie,
        body: {
          kind: 'avatar',
          storageKey: bobKey,
        },
      });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.data.error, 'Unauthorized storage key for this user');
    });

    it('A student cannot delete another student files', async () => {
      // Bob owns a file
      const bobKey = 'users/bob/avatar/bob.jpg';
      await db.query(`
        INSERT INTO files (id, username, kind, bucket, storage_key, mime, size_bytes, created)
        VALUES ('f-bob-1', 'bob', 'avatar', 'public-media', $1, 'image/jpeg', 100, $2)
      `, [bobKey, Date.now()]);
      mockS3.store.set(`public-media:${bobKey}`, { ContentLength: 100, ContentType: 'image/jpeg' });

      // Alice tries to delete Bob's file
      const res = await request(server, '/api/files', {
        method: 'DELETE',
        cookie: aliceCookie,
        body: { storageKey: bobKey },
      });

      assert.strictEqual(res.status, 404);
      // File still exists in mock storage and database
      assert.ok(mockS3.store.has(`public-media:${bobKey}`));
    });

    it('A private resume cannot be opened by another student', async () => {
      // Add a private resume for Bob
      const bobResumeKey = 'users/bob/resume/resume.pdf';
      await db.query(`
        INSERT INTO files (id, username, kind, bucket, storage_key, mime, size_bytes, created)
        VALUES ('f-bob-resume', 'bob', 'resume', 'private-files', $1, 'application/pdf', 1024, $2)
      `, [bobResumeKey, Date.now()]);
      await db.query('UPDATE users SET resume_public = false WHERE username = $1', ['bob']);

      // Alice tries to access Bob's private resume
      const res = await request(server, '/api/resume/bob', {
        cookie: aliceCookie,
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.data.error, 'This resume is private');

      // Bob (owner) can access their own resume
      const bobOwnRes = await request(server, '/api/resume/bob?json=1', {
        cookie: bobCookie,
      });
      assert.strictEqual(bobOwnRes.status, 200);
      assert.ok(bobOwnRes.data.url.includes(bobResumeKey));

      // Toggle Bob resume to public
      await db.query('UPDATE users SET resume_public = true WHERE username = $1', ['bob']);
      const publicRes = await request(server, '/api/resume/bob?json=1', {
        cookie: aliceCookie,
      });
      assert.strictEqual(publicRes.status, 200);
      assert.ok(publicRes.data.url.includes(bobResumeKey));
    });

    it('Wrong file type or oversized file is rejected', async () => {
      // 1. Wrong content type on upload-url
      const wrongMime = await request(server, '/api/files/upload-url', {
        method: 'POST',
        cookie: aliceCookie,
        body: { kind: 'avatar', contentType: 'application/pdf' },
      });
      assert.strictEqual(wrongMime.status, 400);

      // 2. Oversized image (> 1 MB) rejected on complete
      const urlRes = await request(server, '/api/files/upload-url', {
        method: 'POST',
        cookie: aliceCookie,
        body: { kind: 'avatar', contentType: 'image/jpeg' },
      });
      assert.strictEqual(urlRes.status, 200);
      const key = urlRes.data.storageKey;

      // Mock oversized file in S3 (1.5 MB)
      mockS3.store.set(`public-media:${key}`, {
        ContentLength: 1.5 * 1024 * 1024,
        ContentType: 'image/jpeg',
      });

      const compRes = await request(server, '/api/files/complete', {
        method: 'POST',
        cookie: aliceCookie,
        body: { kind: 'avatar', storageKey: key },
      });
      assert.strictEqual(compRes.status, 400);
      assert.strictEqual(compRes.data.error, 'Image must be 1 MB or smaller');
      // Must be deleted from S3
      assert.strictEqual(mockS3.store.has(`public-media:${key}`), false);
    });
  });

  describe('Scale & Pagination', () => {
    it('API reports max 30 by default', async () => {
      delete process.env.MAX_STUDENTS;
      const meRes = await request(server, '/api/me');
      assert.strictEqual(meRes.status, 200);
      assert.strictEqual(meRes.data.max, 30);

      const stuRes = await request(server, '/api/students');
      assert.strictEqual(stuRes.status, 200);
      assert.strictEqual(stuRes.data.max, 30);
    });

    it('GET /api/students pagination and search work', async () => {
      // Query pagination
      const page1 = await request(server, '/api/students?limit=2&offset=0');
      assert.strictEqual(page1.status, 200);
      assert.strictEqual(page1.data.students.length, 2);
      assert.strictEqual(page1.data.students[0].n, 1);
      assert.strictEqual(page1.data.students[1].n, 2);
      assert.ok(page1.data.count >= 3);

      // Search matching name or role
      const searchRes = await request(server, '/api/students?q=Alice');
      assert.strictEqual(searchRes.status, 200);
      assert.ok(searchRes.data.students.some((s) => s.username === 'alice'));
    });

    it('Home grid renders 30 tiles (3 joined + 27 open) when MAX <= 60', () => {
      // Setup mock DOM environment
      global.window = global;
      global.addEventListener = () => {};
      global.innerWidth = 1200;
      global.innerHeight = 800;
      global.scrollY = 0;
      global.performance = { now: () => Date.now() };
      global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
      function makeEl(tag) {
        const children = [];
        const attrs = {};
        return {
          nodeType: 1,
          tagName: tag.toUpperCase(),
          className: '',
          style: { setProperty() {} },
          classList: { add(c) { this.className += ' ' + c; }, remove() {} },
          setAttribute(k, v) { attrs[k] = v; if (k === 'class') this.className = v; },
          getAttribute(k) { return attrs[k]; },
          append(...kids) { for (const k of kids) children.push(typeof k === 'string' ? { textContent: k } : k); },
          replaceChildren(...kids) { children.length = 0; this.append(...kids); },
          addEventListener() {},
          cloneNode() { return makeEl(tag); },
          getContext: () => ({ fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {} }),
          children,
          get childNodes() { return children; }
        };
      }
      global.document = {
        querySelector: () => makeEl('div'),
        querySelectorAll: () => [],
        addEventListener: () => {},
        documentElement: { style: { setProperty() {} } },
        createElement: makeEl,
        createElementNS: (ns, tag) => makeEl(tag),
        createTextNode: (t) => ({ nodeType: 3, textContent: t })
      };
      global.matchMedia = () => ({ matches: false });
      global.IntersectionObserver = class { observe() {} unobserve() {} };

      let code = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
      code = code.replace(/\(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');
      const app = (new Function(code + '; return { homeView, setVars: (m, c, t, s) => { MAX=m; count=c; total=t; students=s; } };'))();

      // 1. Small class mode: MAX = 30, 3 joined students
      app.setVars(30, 3, 3, [
        { username: 'thrishank_kumar', name: 'Thrishank Kumar', role: 'Student', n: 1 },
        { username: 'lohith_m', name: 'Lohith M', role: 'Student', n: 2 },
        { username: 'pravin_kumar', name: 'Pravin Kumar', role: 'Student', n: 3 },
      ]);

      const viewObj = app.homeView();
      const crewSec = viewObj.el.children.find((c) => c.getAttribute('id') === 'crew');
      const gridEl = crewSec.children.find((c) => c.className?.includes('grid'));
      const tiles = gridEl.children;

      assert.strictEqual(tiles.length, 30, 'Small class mode must render exactly 30 tiles');
      const joinedTiles = tiles.filter((t) => !t.className?.includes('open'));
      const openTiles = tiles.filter((t) => t.className?.includes('open'));
      assert.strictEqual(joinedTiles.length, 3, 'Must render 3 joined student tiles');
      assert.strictEqual(openTiles.length, 27, 'Must render 27 open spot tiles');

      // Verify open tile labels
      assert.strictEqual(openTiles[0].getAttribute('aria-label'), 'Open spot');
      assert.strictEqual(openTiles[openTiles.length - 1].getAttribute('aria-label'), 'Open spot');

      // No search bar in small class mode
      const searchBar = crewSec.children.find((c) => c.className?.includes('crew-search-bar'));
      assert.strictEqual(Boolean(searchBar), false, 'No search bar in small class mode');

      // 2. Scalable mode: MAX = 200 (> 60)
      app.setVars(200, 3, 3, [
        { username: 'thrishank_kumar', name: 'Thrishank Kumar', role: 'Student', n: 1 },
        { username: 'lohith_m', name: 'Lohith M', role: 'Student', n: 2 },
        { username: 'pravin_kumar', name: 'Pravin Kumar', role: 'Student', n: 3 },
      ]);
      const viewObj2 = app.homeView();
      const crewSec2 = viewObj2.el.children.find((c) => c.getAttribute('id') === 'crew');
      const searchBar2 = crewSec2.children.find((c) => c.className?.includes('crew-search-bar'));
      assert.strictEqual(Boolean(searchBar2), true, 'Search bar must be present in large class mode');
      const gridEl2 = crewSec2.children.find((c) => c.className?.includes('grid'));
      // In large class mode: 3 joined + 1 single "N spots left" tile = 4 tiles
      assert.strictEqual(gridEl2.children.length, 4);
    });

    it('Student cap holds under concurrent signups: 3 seeded count toward 30, only 27 more succeed and the 28th is refused with a clear message', async () => {
      // Ensure only the 3 seeded accounts exist in the database
      await db.query(`
        DELETE FROM users
        WHERE email NOT IN (
          'thrishank.kumar.s.129@kalvium.community',
          'lohith.m.s.129@kalvium.community',
          'pravin.kumar.s.129@kalvium.community'
        )
      `);

      const curRes = await db.query('SELECT count(*) FROM users');
      const currentCount = parseInt(curRes.rows[0].count, 10);
      assert.strictEqual(currentCount, 3, 'Expected exactly 3 seeded accounts before cap test');

      // Generate 28 valid student emails
      const promises = [];
      for (let i = 0; i < 28; i++) {
        const letter = String.fromCharCode(97 + (i % 26)) + (i >= 26 ? 'x' : '');
        promises.push(
          request(server, '/api/google', {
            method: 'POST',
            body: { credential: `dev:student${letter}.s.129@kalvium.community` },
          })
        );
      }

      const results = await Promise.all(promises);
      const successCount = results.filter((r) => r.status === 200).length;
      const rejected = results.filter((r) => r.status === 403);

      // Exactly 27 more signups succeed to reach cap of 30
      assert.strictEqual(successCount, 27, 'Expected exactly 27 signups to succeed');
      // The 28th is refused
      assert.strictEqual(rejected.length, 1, 'Expected the 28th signup to be refused');
      assert.strictEqual(rejected[0].data.error, 'All 30 spots are taken');

      // Final count in DB must be exactly 30
      const finalCountRes = await db.query('SELECT count(*) FROM users');
      assert.strictEqual(parseInt(finalCountRes.rows[0].count, 10), 30);

      // Clean up temporary students created in this test
      await db.query(`DELETE FROM users WHERE email LIKE 'student%.s.129@kalvium.community'`);
    });
  });

  describe('Account Lifecycle & Sessions', () => {
    it('Deleting an account removes its files and database rows', async () => {
      // Create user Charlie
      const res = await request(server, '/api/google', {
        method: 'POST',
        // Max is 10, temporarily expand cap for this test
      });
      // Test direct delete flow with an existing user (e.g. Alice)
      // Login as Alice
      const loginRes = await request(server, '/api/google', {
        method: 'POST',
        body: { credential: 'dev:alice.s.129@kalvium.community' },
      });
      const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

      // Add a file for Alice
      const key = 'users/alice/avatar/alice-del.jpg';
      await db.query(`
        INSERT INTO files (id, username, kind, bucket, storage_key, mime, size_bytes, created)
        VALUES ('f-alice-del', 'alice', 'avatar', 'public-media', $1, 'image/jpeg', 200, $2)
      `, [key, Date.now()]);
      mockS3.store.set(`public-media:${key}`, { ContentLength: 200, ContentType: 'image/jpeg' });

      // Delete account
      const delRes = await request(server, '/api/account', {
        method: 'DELETE',
        cookie,
      });
      assert.strictEqual(delRes.status, 200);

      // Verify files deleted from S3
      assert.strictEqual(mockS3.store.has(`public-media:${key}`), false);

      // Verify user and files deleted from database
      const uCheck = await db.query('SELECT * FROM users WHERE username = $1', ['alice']);
      assert.strictEqual(uCheck.rows.length, 0);
      const fCheck = await db.query('SELECT * FROM files WHERE username = $1', ['alice']);
      assert.strictEqual(fCheck.rows.length, 0);
    });

    it('Sessions expire and are rejected', async () => {
      // Login as Bob
      const loginRes = await request(server, '/api/google', {
        method: 'POST',
        body: { credential: 'dev:bob.s.129@kalvium.community' },
      });
      const cookie = loginRes.headers['set-cookie'][0].split(';')[0];

      // Verify active session works
      const meActive = await request(server, '/api/profile', { cookie });
      assert.strictEqual(meActive.status, 200);

      // Expire Bob's session in DB
      await db.query('UPDATE sessions SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE username = $1', ['bob']);

      // Attempt to access with expired session
      const meExpired = await request(server, '/api/profile', { cookie });
      assert.strictEqual(meExpired.status, 401);
    });

    it('migrate-json.js imports existing db.json correctly', async () => {
      const tempJsonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-migrate-'));
      const tempJsonFile = path.join(tempJsonDir, 'db.json');
      fs.writeFileSync(tempJsonFile, JSON.stringify({
        users: {
          test_imported: {
            username: 'test_imported',
            name: 'Imported Student',
            email: 'imported.s.129@kalvium.community',
            tagline: 'Imported from json',
            skills: ['Node', 'SQL'],
            created: 123456,
            updated: 123456,
          },
        },
      }));

      const res = await migrateJson(tempJsonFile);
      assert.strictEqual(res.migratedUsers, 1);

      const check = await db.query('SELECT * FROM users WHERE username = $1', ['test_imported']);
      assert.strictEqual(check.rows.length, 1);
      assert.strictEqual(check.rows[0].name, 'Imported Student');

      fs.rmSync(tempJsonDir, { recursive: true, force: true });
    });
  });
});
