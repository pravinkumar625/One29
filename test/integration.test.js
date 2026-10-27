const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function makeRequest(baseUrl, endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: Object.assign(
        {},
        options.body ? { 'Content-Type': 'application/json' } : {},
        options.method && options.method !== 'GET' ? { 'X-Req': '1' } : {},
        options.cookie ? { Cookie: options.cookie } : {}
      ),
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json !== null ? json : data,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('Google Auth & Access Control - Integration Tests', () => {
  let mockGoogleServer;
  let mockPort;
  let serverProcess;
  let serverPort;
  let baseUrl;
  let tempDir;

  const GOOGLE_CLIENT_ID = 'test-google-client-id';

  const mockTokens = {
    'token-pravin-seeded': {
      status: 200,
      body: {
        aud: GOOGLE_CLIENT_ID,
        email: 'pravin.kumar.s.129@kalvium.community',
        email_verified: 'true',
        sub: 'g-sub-pravin-001',
        name: 'Pravin Kumar',
      },
    },
    'token-rahul-allowed': {
      status: 200,
      body: {
        aud: GOOGLE_CLIENT_ID,
        email: 'rahul.s.129@kalvium.community',
        email_verified: 'true',
        sub: 'g-sub-rahul-002',
        name: 'Rahul',
      },
    },
    'token-disallowed': {
      status: 200,
      body: {
        aud: GOOGLE_CLIENT_ID,
        email: 'pravin.kumar.s.128@kalvium.community',
        email_verified: 'true',
        sub: 'g-sub-bad-003',
        name: 'Pravin 128',
      },
    },
    'token-wrong-aud': {
      status: 200,
      body: {
        aud: 'wrong-google-client-id',
        email: 'rahul.s.129@kalvium.community',
        email_verified: 'true',
        sub: 'g-sub-wrong-004',
        name: 'Rahul',
      },
    },
  };

  before(async () => {
    // 1. Start mock Google token server
    await new Promise((resolve) => {
      mockGoogleServer = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        const token = u.searchParams.get('id_token');
        if (mockTokens[token]) {
          const resp = mockTokens[token];
          res.writeHead(resp.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(resp.body));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_token' }));
        }
      });
      mockGoogleServer.listen(0, '127.0.0.1', () => {
        mockPort = mockGoogleServer.address().port;
        resolve();
      });
    });

    // 2. Prepare temp data directory & server port
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
    serverPort = 35000 + Math.floor(Math.random() * 15000);
    baseUrl = `http://127.0.0.1:${serverPort}`;

    // 3. Start app server
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, {
        PORT: String(serverPort),
        DATA_DIR: tempDir,
        GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID,
        TOKENINFO_URL: `http://127.0.0.1:${mockPort}/tokeninfo`,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait until server is ready
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await makeRequest(baseUrl, '/api/me');
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!ready) throw new Error('Server failed to start within timeout');
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill();
      await new Promise((r) => setTimeout(r, 200));
    }
    if (mockGoogleServer) {
      await new Promise((resolve) => mockGoogleServer.close(resolve));
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('creates the 3 pre-made student accounts on server start', async () => {
    const res = await makeRequest(baseUrl, '/api/students');
    assert.strictEqual(res.status, 200);
    const students = res.data.students;
    assert.strictEqual(students.length, 3);
    const names = students.map((s) => s.name);
    assert.ok(names.includes('Thrishank Kumar'));
    assert.ok(names.includes('Lohith M'));
    assert.ok(names.includes('Pravin Kumar'));
  });

  it('links a seeded email to its pre-made page on first Google sign-in', async () => {
    const res = await makeRequest(baseUrl, '/api/google', {
      method: 'POST',
      body: { credential: 'token-pravin-seeded' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.me.name, 'Pravin Kumar');
    assert.strictEqual(res.data.me.username, 'pravin_kumar');

    // Verify session cookie was set
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie && setCookie.length > 0);
    const cookie = setCookie[0].split(';')[0];

    // Check /api/me with session
    const meRes = await makeRequest(baseUrl, '/api/me', { cookie });
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.data.me.username, 'pravin_kumar');

    // Total student count must remain 3 (linked existing, not duplicated)
    const listRes = await makeRequest(baseUrl, '/api/students');
    assert.strictEqual(listRes.data.students.length, 3);
  });

  it('allows an authorized new email, creating a session and a page', async () => {
    const res = await makeRequest(baseUrl, '/api/google', {
      method: 'POST',
      body: { credential: 'token-rahul-allowed' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.me.name, 'Rahul');
    assert.strictEqual(res.data.me.username, 'rahul');

    // Check session cookie
    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie && setCookie.length > 0);
    const cookie = setCookie[0].split(';')[0];

    // Access profile endpoint
    const meRes = await makeRequest(baseUrl, '/api/me', { cookie });
    assert.strictEqual(meRes.status, 200);
    assert.strictEqual(meRes.data.me.username, 'rahul');

    // Student page is accessible
    const pageRes = await makeRequest(baseUrl, '/api/students/rahul');
    assert.strictEqual(pageRes.status, 200);
    assert.strictEqual(pageRes.data.student.name, 'Rahul');

    // Total count increased to 4
    const listRes = await makeRequest(baseUrl, '/api/students');
    assert.strictEqual(listRes.data.students.length, 4);
  });

  it('rejects a disallowed email with 403 and creates no account or session', async () => {
    const beforeList = await makeRequest(baseUrl, '/api/students');
    const beforeCount = beforeList.data.students.length;

    const res = await makeRequest(baseUrl, '/api/google', {
      method: 'POST',
      body: { credential: 'token-disallowed' },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.error, 'Access denied. Only authorized student email addresses are permitted.');
    assert.ok(!res.headers['set-cookie'], 'no session cookie should be issued');

    // Verify no account was created
    const afterList = await makeRequest(baseUrl, '/api/students');
    assert.strictEqual(afterList.data.students.length, beforeCount);
  });

  it('rejects a wrong-audience token with 401', async () => {
    const res = await makeRequest(baseUrl, '/api/google', {
      method: 'POST',
      body: { credential: 'token-wrong-aud' },
    });
    assert.strictEqual(res.status, 401);
  });

  it('returns the same account when signing in twice without creating duplicates', async () => {
    const res = await makeRequest(baseUrl, '/api/google', {
      method: 'POST',
      body: { credential: 'token-rahul-allowed' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.me.username, 'rahul');

    // Count is still 4
    const listRes = await makeRequest(baseUrl, '/api/students');
    assert.strictEqual(listRes.data.students.length, 4);
  });
});
