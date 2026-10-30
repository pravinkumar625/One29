const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db.js');

// Optional S3 support for Phase 3 avatar upload
let s3Client = null;
let PutObjectCommand = null;
try {
  const s3 = require('@aws-sdk/client-s3');
  PutObjectCommand = s3.PutObjectCommand;
  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (endpoint && accessKeyId && secretAccessKey) {
    s3Client = new s3.S3Client({
      endpoint,
      region: process.env.S3_REGION || 'auto',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }
} catch {}

async function migrateJson(customDbFile = null) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const dbFile = customDbFile || path.join(dataDir, 'db.json');

  if (!fs.existsSync(dbFile)) {
    console.log(`[migrate-json] No db.json found at ${dbFile}. Nothing to migrate.`);
    return { migratedUsers: 0, migratedAvatars: 0 };
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  } catch (err) {
    console.error(`[migrate-json] Failed to parse ${dbFile}:`, err.message);
    return { migratedUsers: 0, migratedAvatars: 0 };
  }

  await db.runMigrations();

  const users = Object.values(data.users || {});
  let migratedUsers = 0;
  let migratedAvatars = 0;

  for (const u of users) {
    const username = (u.username || '').toLowerCase().trim();
    if (!username) continue;

    const name = u.name || username;
    const sub = u.googleId || null;
    const email = u.email ? u.email.trim() : null;
    const tagline = u.tagline || '';
    const role = u.role || '';
    const bio = u.bio || '';
    const skills = JSON.stringify(Array.isArray(u.skills) ? u.skills : []);
    const links = JSON.stringify(u.links || {});
    const projects = JSON.stringify(Array.isArray(u.projects) ? u.projects : []);
    const theme = Number.isInteger(u.theme) ? u.theme : 0;
    const created = u.created || Date.now();
    const updated = u.updated || Date.now();

    await db.query(`
      INSERT INTO users (
        username, name, sub, email, tagline, role, bio,
        skills, links, projects, theme, created, updated
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (username) DO UPDATE SET
        name = EXCLUDED.name,
        sub = COALESCE(users.sub, EXCLUDED.sub),
        email = COALESCE(users.email, EXCLUDED.email),
        tagline = CASE WHEN users.tagline = '' THEN EXCLUDED.tagline ELSE users.tagline END,
        role = CASE WHEN users.role = '' THEN EXCLUDED.role ELSE users.role END,
        bio = CASE WHEN users.bio = '' THEN EXCLUDED.bio ELSE users.bio END,
        skills = CASE WHEN users.skills = '[]'::jsonb THEN EXCLUDED.skills ELSE users.skills END,
        links = CASE WHEN users.links = '{}'::jsonb THEN EXCLUDED.links ELSE users.links END,
        projects = CASE WHEN users.projects = '[]'::jsonb THEN EXCLUDED.projects ELSE users.projects END,
        theme = CASE WHEN users.theme = 0 THEN EXCLUDED.theme ELSE users.theme END,
        updated = EXCLUDED.updated
    `, [username, name, sub, email, tagline, role, bio, skills, links, projects, theme, created, updated]);

    migratedUsers++;

    // If user had a base64 avatar in db.json and S3 is configured, upload to public bucket
    if (u.avatar && /^data:(image\/\w+);base64,(.+)$/.test(u.avatar) && s3Client && process.env.S3_BUCKET_PUBLIC) {
      const match = /^data:(image\/(\w+));base64,(.+)$/.exec(u.avatar);
      if (match) {
        const mime = match[1];
        const ext = match[2] === 'jpeg' ? 'jpg' : match[2];
        const buffer = Buffer.from(match[3], 'base64');
        const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        const storageKey = `users/${username}/avatar/${fileId}.${ext}`;
        const bucket = process.env.S3_BUCKET_PUBLIC;

        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: storageKey,
            Body: buffer,
            ContentType: mime,
            CacheControl: 'public, max-age=31536000, immutable',
          }));

          // Delete existing avatar record if any
          await db.query('DELETE FROM files WHERE username = $1 AND kind = $2', [username, 'avatar']);

          // Record in files table
          await db.query(`
            INSERT INTO files (id, username, kind, bucket, storage_key, mime, size_bytes, created)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [fileId, username, 'avatar', bucket, storageKey, mime, buffer.length, Date.now()]);

          migratedAvatars++;
        } catch (s3Err) {
          console.warn(`[migrate-json] S3 upload skipped for ${username}:`, s3Err.message);
        }
      }
    }
  }

  console.log(`[migrate-json] Successfully migrated ${migratedUsers} users (${migratedAvatars} avatars) from ${dbFile}.`);
  return { migratedUsers, migratedAvatars };
}

if (require.main === module) {
  migrateJson()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate-json] Error:', err);
      process.exit(1);
    });
}

module.exports = { migrateJson };
