const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { generateResumePdf, sanitizeForFont } = require('../pdf.js');

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.GOOGLE_CLIENT_ID = '';

const db = require('../db.js');
const { server, dbReady } = require('../server.js');

function extractTextFromPdfBuffer(buf) {
  let text = '';
  let i = 0;
  while ((i = buf.indexOf('stream', i)) !== -1) {
    let s = i + 6;
    if (buf[s] === 13) s++;
    if (buf[s] === 10) s++;
    const e = buf.indexOf('endstream', s);
    if (e === -1) break;
    let raw = '';
    try {
      raw = zlib.inflateSync(buf.slice(s, e)).toString();
    } catch {
      raw = buf.slice(s, e).toString();
    }
    // Kerning array format [<hex1> number <hex2> ...] TJ
    for (const tj of raw.matchAll(/\[(.*?)\]\s*TJ/gs)) {
      let tjStr = '';
      for (const m of tj[1].matchAll(/<([0-9a-fA-F]+)>/g)) {
        try {
          tjStr += Buffer.from(m[1], 'hex').toString('utf8');
        } catch {}
      }
      text += tjStr + ' ';
    }
    // Simple text format (text) Tj
    for (const m of raw.matchAll(/\(([^)]+)\)\s*Tj/g)) {
      text += m[1] + ' ';
    }
    i = e + 9;
  }
  return text;
}

function request(pathStr, options = {}) {
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (res.headers['content-type']?.includes('application/json')) {
          try { json = JSON.parse(buf.toString()); } catch {}
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer: buf,
          data: json !== null ? json : buf.toString(),
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Auto-Generated Resume Tests', () => {
  let cookieStudentA;
  let cookieStudentB;

  before(async () => {
    await dbReady;
    await new Promise((resolve) => server.listen(0, resolve));

    // Sign in student A
    const resA = await request('/api/google', {
      method: 'POST',
      body: { credential: 'dev:thrishank.kumar.s.129@kalvium.community' },
    });
    assert.strictEqual(resA.status, 200);
    cookieStudentA = (resA.headers['set-cookie'] || [])[0]?.split(';')[0];

    // Sign in student B
    const resB = await request('/api/google', {
      method: 'POST',
      body: { credential: 'dev:lohith.m.s.129@kalvium.community' },
    });
    assert.strictEqual(resB.status, 200);
    cookieStudentB = (resB.headers['set-cookie'] || [])[0]?.split(';')[0];
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('unauthenticated requests to /api/resume/auto return 401', async () => {
    const res = await request('/api/resume/auto');
    assert.strictEqual(res.status, 401);
  });

  it('generates a valid PDF for the logged-in student starting with %PDF', async () => {
    const res = await request('/api/resume/auto', { cookie: cookieStudentA });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['content-disposition'], /attachment; filename=".*-Resume\.pdf"/);
    
    // PDF magic bytes %PDF-
    const header = res.buffer.slice(0, 5).toString();
    assert.strictEqual(header, '%PDF-');
  });

  it('supports templates (classic, modern, minimal) and inline preview', async () => {
    const resClassic = await request('/api/resume/auto?template=classic&preview=1', { cookie: cookieStudentA });
    assert.strictEqual(resClassic.status, 200);
    assert.match(resClassic.headers['content-disposition'], /inline; filename=".*-Resume\.pdf"/);
    assert.strictEqual(resClassic.buffer.slice(0, 5).toString(), '%PDF-');

    const resModern = await request('/api/resume/auto?template=modern', { cookie: cookieStudentA });
    assert.strictEqual(resModern.status, 200);
    assert.strictEqual(resModern.buffer.slice(0, 5).toString(), '%PDF-');

    const resMinimal = await request('/api/resume/auto?template=minimal', { cookie: cookieStudentA });
    assert.strictEqual(resMinimal.status, 200);
    assert.strictEqual(resMinimal.buffer.slice(0, 5).toString(), '%PDF-');
  });

  it('contains latest edited data after profile update', async () => {
    const updateRes = await request('/api/profile', {
      method: 'PUT',
      cookie: cookieStudentA,
      body: {
        name: 'Thrishank Kumar',
        role: 'Cloud Architect',
        bio: 'Expert in high scalability systems',
        phone: '+91 99999 88888',
        location: 'Bengaluru, India',
        links: { email: 'public.thrishank@example.com' },
        skills: ['PostgreSQL', 'Node.js', 'Distributed Systems'],
        projects: [{ title: 'Class Of 29 App', desc: 'Awesome class portfolio', url: 'https://github.com' }],
        experience: [{ title: 'Lead Engineer', organisation: 'Tech Corp', start: '2025', end: 'Present', description: 'Architected cloud systems' }],
        education: [{ school: 'Kalvium University', degree: 'B.Tech', field: 'CS', start_year: '2025', end_year: '2029' }],
        certifications: [{ name: 'AWS Solutions Architect', issuer: 'Amazon', year: '2026' }],
        achievements: ['Won First Prize in Global Hackathon'],
        theme: 1,
        resume_public: false,
      },
    });
    assert.strictEqual(updateRes.status, 200);

    const pdfRes = await request('/api/resume/auto', { cookie: cookieStudentA });
    assert.strictEqual(pdfRes.status, 200);
    const pdfText = extractTextFromPdfBuffer(pdfRes.buffer);

    assert.ok(pdfText.includes('CLOUD ARCHITECT'));
    assert.ok(pdfText.includes('Expert in high scalability systems'));
    assert.ok(pdfText.includes('Bengaluru, India'));
    assert.ok(pdfText.includes('+91 99999 88888'));
    assert.ok(pdfText.includes('public.thrishank@example.com'));
    assert.ok(pdfText.includes('Tech Corp'));
    assert.ok(pdfText.includes('Kalvium University'));
  });

  it('never contains the student Google login email in the PDF', async () => {
    const pdfRes = await request('/api/resume/auto', { cookie: cookieStudentA });
    const pdfText = extractTextFromPdfBuffer(pdfRes.buffer);
    assert.ok(!pdfText.includes('thrishank.kumar.s.129@kalvium.community'), 'Google login email must never be exposed');
  });

  it('another student cannot download a private resume (403)', async () => {
    // Student A currently has resume_public: false
    const res = await request('/api/resume/auto/thrishank_kumar', { cookie: cookieStudentB });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.data.error, 'This resume is private');

    // Unauthenticated user also cannot download private resume
    const resAnon = await request('/api/resume/auto/thrishank_kumar');
    assert.strictEqual(resAnon.status, 403);
  });

  it('public endpoint works when resume_public is turned on, but hides the phone number on public view', async () => {
    // Turn on resume_public for Student A
    await request('/api/profile', {
      method: 'PUT',
      cookie: cookieStudentA,
      body: {
        name: 'Thrishank Kumar',
        phone: '+91 99999 88888',
        role: 'Cloud Architect',
        resume_public: true,
      },
    });

    // Student B downloads Student A's public resume
    const resB = await request('/api/resume/auto/thrishank_kumar', { cookie: cookieStudentB });
    assert.strictEqual(resB.status, 200);
    assert.strictEqual(resB.buffer.slice(0, 5).toString(), '%PDF-');
    const pdfTextPublic = extractTextFromPdfBuffer(resB.buffer);

    // Phone MUST NOT appear on public download
    assert.ok(!pdfTextPublic.includes('+91 99999 88888'), 'Phone must NEVER appear on public resume downloads');
    assert.ok(!pdfTextPublic.includes('thrishank.kumar.s.129@kalvium.community'), 'Google email must not appear');

    // Owner downloading via public route or /api/resume/auto DOES get the phone
    const resOwn = await request('/api/resume/auto', { cookie: cookieStudentA });
    const pdfTextOwn = extractTextFromPdfBuffer(resOwn.buffer);
    assert.ok(pdfTextOwn.includes('+91 99999 88888'), 'Owner should see their phone number on their own download');
  });

  it('sanitizes and caps education, experience, achievements, and certifications', async () => {
    const tooManyEducation = Array.from({ length: 10 }, (_, i) => ({
      school: `School ${i}`,
      degree: 'Degree',
      field: 'Field',
    }));
    const tooManyExperience = Array.from({ length: 15 }, (_, i) => ({
      title: `Job ${i}`,
      organisation: 'Org',
    }));
    const tooManyAchievements = Array.from({ length: 20 }, (_, i) => `Achievement ${i}`);
    const tooManyCertifications = Array.from({ length: 20 }, (_, i) => ({
      name: `Cert ${i}`,
      issuer: 'Issuer',
    }));

    const updateRes = await request('/api/profile', {
      method: 'PUT',
      cookie: cookieStudentA,
      body: {
        name: 'Thrishank Kumar',
        education: tooManyEducation,
        experience: tooManyExperience,
        achievements: tooManyAchievements,
        certifications: tooManyCertifications,
      },
    });

    assert.strictEqual(updateRes.status, 200);
    assert.strictEqual(updateRes.data.profile.education.length, 6);
    assert.strictEqual(updateRes.data.profile.experience.length, 8);
    assert.strictEqual(updateRes.data.profile.achievements.length, 10);
    assert.strictEqual(updateRes.data.profile.certifications.length, 10);
  });

  it('long or odd text (emojis, unicode, special chars) does not crash generation', async () => {
    const oddUser = {
      name: 'Odd 🚀 User 👨‍💻 — with “quotes” & symbols € ¥ • …',
      role: 'Full-stack & AI/ML 🤖 Developer',
      bio: 'Here is a super long paragraph with special punctuation: “Hello World”, ‘single’, — dashes —, bullets •, accented é, ü, ñ, and emojis 🎉🔥✨. '.repeat(10),
      phone: '+1 (555) 123-4567 📞',
      location: 'Tokyo / 東京 / São Paulo',
      skills: ['Node.js 🚀', 'Python 🐍', 'C++ ⚡', 'GraphQL ✨'],
      projects: [{
        title: 'Project 🌟 Alpha “Super”',
        desc: 'Testing odd characters and descriptions with Unicode symbols: €100 discount, — long em dash, and emoji reactions ❤️👍.',
        url: 'https://example.com/🚀',
      }],
      experience: [{
        title: 'Senior “Rockstar” Dev 💻',
        organisation: 'Global Tech Corp 🌐',
        start: 'Jan 2024',
        end: 'Present',
        description: 'Lead engineering for ultra-fast platforms ⚡ with 99.99% uptime! Em dash — tested.',
      }],
      education: [{
        school: 'University of Science & Tech 🎓',
        degree: 'Master of Science (M.S.)',
        field: 'Computer Engineering',
        start_year: '2023',
        end_year: '2025',
      }],
      certifications: [{
        name: 'Certified Kubernetes Administrator (CKA) ☸️',
        issuer: 'CNCF 🏆',
        year: '2024',
      }],
      achievements: [
        'Top 1% in Global Coding Championship 🥇',
        'Published paper in IEEE Transactions on Software Engineering 📄',
      ],
      theme: 2,
    };

    const pdfBuf = await generateResumePdf(oddUser, { template: 'modern' });
    assert.ok(pdfBuf.length > 1000);
    assert.strictEqual(pdfBuf.slice(0, 5).toString(), '%PDF-');
  });
});

