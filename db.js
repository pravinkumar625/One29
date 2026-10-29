// Neon Postgres & Local JSON Database Adapter for Class Portfolio
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
let usePostgres = false;

const memoryDb = {
  users: {},
  sessions: {},
};

let dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
let dbFile = path.join(dataDir, 'db.json');
let lastMtime = 0;

function setPaths(customDataDir) {
  if (customDataDir) {
    dataDir = customDataDir;
    dbFile = path.join(dataDir, 'db.json');
  }
}

// ----------------- Local JSON Helpers -----------------
function loadJsonDb() {
  try {
    if (!fs.existsSync(dbFile)) return;
    const stat = fs.statSync(dbFile);
    if (stat.mtimeMs > lastMtime) {
      const fresh = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      fresh.users ??= {};
      fresh.sessions ??= {};
      memoryDb.users = fresh.users;
      memoryDb.sessions = fresh.sessions;
      lastMtime = stat.mtimeMs;
    }
  } catch (err) {
    console.error('Error loading local db.json:', err.message);
  }
}

function saveJsonDb() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(memoryDb, null, 2));
    fs.renameSync(dbFile + '.tmp', dbFile);
    lastMtime = fs.statSync(dbFile).mtimeMs;
  } catch (err) {
    console.error('Error saving local db.json:', err.message);
  }
}

// ----------------- Postgres / Neon Helpers -----------------
async function initPostgres(connectionString) {
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // Verify connection
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS portfolio_users (
        username VARCHAR(40) PRIMARY KEY,
        name VARCHAR(120),
        email VARCHAR(120),
        google_id VARCHAR(120),
        data JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS portfolio_sessions (
        token_hash VARCHAR(64) PRIMARY KEY,
        username VARCHAR(40) NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_portfolio_users_email ON portfolio_users (email);
      CREATE INDEX IF NOT EXISTS idx_portfolio_users_google_id ON portfolio_users (google_id);
    `);

    // Load users from Postgres into memory cache
    const usersRes = await client.query('SELECT username, data FROM portfolio_users');
    if (usersRes.rows.length === 0) {
      // If Postgres table is empty, check if we have local db.json data to migrate
      loadJsonDb();
      const localUsers = Object.values(memoryDb.users);
      if (localUsers.length > 0) {
        console.log(`Migrating ${localUsers.length} existing student accounts to Neon Postgres...`);
        for (const u of localUsers) {
          await client.query(
            `INSERT INTO portfolio_users (username, name, email, google_id, data, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (username) DO NOTHING`,
            [u.username, u.name, u.email || null, u.googleId || null, JSON.stringify(u), u.created || Date.now(), u.updated || Date.now()]
          );
        }
        console.log('Migration to Neon Postgres complete!');
      }
    } else {
      for (const row of usersRes.rows) {
        memoryDb.users[row.username] = row.data;
      }
    }

    // Load active sessions from Postgres
    const now = Date.now();
    const sessionsRes = await client.query('SELECT token_hash, username, expires_at FROM portfolio_sessions WHERE expires_at > $1', [now]);
    for (const row of sessionsRes.rows) {
      memoryDb.sessions[row.token_hash] = { u: row.username, exp: Number(row.expires_at) };
    }

    usePostgres = true;
    console.log('Connected to Neon PostgreSQL database successfully.');
  } finally {
    client.release();
  }
}

// ----------------- Exported DB Interface -----------------
async function init(options = {}) {
  if (options.dataDir) setPaths(options.dataDir);

  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
  if (dbUrl) {
    try {
      await initPostgres(dbUrl);
      return;
    } catch (err) {
      console.error('Failed to connect to Neon PostgreSQL. Falling back to local db.json:', err.message);
    }
  }

  // Fallback to local JSON file
  usePostgres = false;
  loadJsonDb();
  console.log('Using local file database:', dbFile);
}

function getUsers() {
  if (!usePostgres) loadJsonDb();
  return memoryDb.users;
}

function getUser(username) {
  if (!username) return null;
  return getUsers()[username] || null;
}

function getUserByGoogleId(sub) {
  if (!sub) return null;
  return Object.values(getUsers()).find((u) => u.googleId === sub) || null;
}

function getUserByEmail(email) {
  if (!email) return null;
  return Object.values(getUsers()).find((u) => u.email === email) || null;
}

async function saveUser(user) {
  if (!user || !user.username) return;
  memoryDb.users[user.username] = user;

  if (usePostgres && pool) {
    try {
      await pool.query(
        `INSERT INTO portfolio_users (username, name, email, google_id, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (username) DO UPDATE
         SET name = EXCLUDED.name,
             email = EXCLUDED.email,
             google_id = EXCLUDED.google_id,
             data = EXCLUDED.data,
             updated_at = EXCLUDED.updated_at`,
        [
          user.username,
          user.name,
          user.email || null,
          user.googleId || null,
          JSON.stringify(user),
          user.created || Date.now(),
          user.updated || Date.now(),
        ]
      );
    } catch (err) {
      console.error('Error saving user to Neon Postgres:', err.message);
    }
  } else {
    saveJsonDb();
  }
}

async function deleteUser(username) {
  if (!username) return;
  delete memoryDb.users[username];

  // Remove any sessions for this user
  for (const k of Object.keys(memoryDb.sessions)) {
    if (memoryDb.sessions[k].u === username) {
      delete memoryDb.sessions[k];
    }
  }

  if (usePostgres && pool) {
    try {
      await pool.query('DELETE FROM portfolio_users WHERE username = $1', [username]);
      await pool.query('DELETE FROM portfolio_sessions WHERE username = $1', [username]);
    } catch (err) {
      console.error('Error deleting user from Neon Postgres:', err.message);
    }
  } else {
    saveJsonDb();
  }
}

function getSession(tokenHash) {
  if (!usePostgres) loadJsonDb();
  const s = memoryDb.sessions[tokenHash];
  if (!s || s.exp < Date.now()) return null;
  return s;
}

async function saveSession(tokenHash, username, exp) {
  memoryDb.sessions[tokenHash] = { u: username, exp };

  if (usePostgres && pool) {
    try {
      await pool.query(
        `INSERT INTO portfolio_sessions (token_hash, username, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (token_hash) DO UPDATE
         SET username = EXCLUDED.username,
             expires_at = EXCLUDED.expires_at`,
        [tokenHash, username, exp]
      );
    } catch (err) {
      console.error('Error saving session to Neon Postgres:', err.message);
    }
  } else {
    saveJsonDb();
  }
}

async function deleteSession(tokenHash) {
  delete memoryDb.sessions[tokenHash];

  if (usePostgres && pool) {
    try {
      await pool.query('DELETE FROM portfolio_sessions WHERE token_hash = $1', [tokenHash]);
    } catch (err) {
      console.error('Error deleting session from Neon Postgres:', err.message);
    }
  } else {
    saveJsonDb();
  }
}

function isPostgres() {
  return usePostgres;
}

module.exports = {
  init,
  getUsers,
  getUser,
  getUserByGoogleId,
  getUserByEmail,
  saveUser,
  deleteUser,
  getSession,
  saveSession,
  deleteSession,
  isPostgres,
  setPaths,
};
