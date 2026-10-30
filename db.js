const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function loadEnvFile(filename) {
  try {
    const envPath = path.join(__dirname, filename);
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = /^([^=]+)=(.*)$/.exec(trimmed);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }
  } catch {}
}
loadEnvFile('.env.local');
loadEnvFile('.env');

let activePool = null;

function getPool() {
  if (activePool) return activePool;

  // In automated test runs, always use isolated in-memory pg-mem unless explicitly overridden
  if (process.env.NODE_ENV === 'test' || process.env.TEST_PG_MEM === '1' || process.env.TOKENINFO_URL) {
    try {
      const { newDb, DataType } = require('pg-mem');
      const mem = newDb();
      mem.public.registerFunction({
        name: 'lower',
        args: [DataType.text],
        returns: DataType.text,
        implementation: (x) => (x ? x.toLowerCase() : x),
      });
      const adapter = mem.adapters.createPg();
      activePool = new adapter.Pool();
      return activePool;
    } catch (err) {
      console.error('[db:test] pg-mem initialization failed:', err.message);
    }
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('\n[FATAL] Missing DATABASE_URL environment variable.');
    console.error('Please configure DATABASE_URL in your environment or .env file to connect to Postgres.\n');
    process.exit(1);
  }

  // Neon requires SSL. Use rejectUnauthorized: false for maximum compatibility across environments.
  activePool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  activePool.on('error', (err) => {
    // Suppress unhandled idle client errors on slept connections
    console.warn('[db:pool] idle connection warning:', err.message);
  });

  return activePool;
}

function setPool(pool) {
  activePool = pool;
}

async function query(text, params = [], maxRetries = 3) {
  const pool = getPool();
  let attempt = 0;
  while (true) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      attempt++;
      // Neon sleeps when idle, so retry the query with backoff on connection errors
      const isTransient = /connection|closed|terminat|timeout|ECONNRESET|EAI_AGAIN|57P01|57P02|57P03/i.test(err.message || '');
      if (attempt < maxRetries && isTransient) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function withTransaction(callback) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations(migrationsDir = path.join(__dirname, 'migrations')) {
  if (!fs.existsSync(migrationsDir)) return [];

  // Ensure schema_migrations exists
  try {
    await query('SELECT 1 FROM schema_migrations LIMIT 1');
  } catch {
    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ
      )
    `);
  }

  const appliedRows = await query('SELECT id FROM schema_migrations ORDER BY id ASC');
  const appliedSet = new Set(appliedRows.rows.map((r) => r.id));

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied = [];

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, NOW())', [file]);
    });

    newlyApplied.push(file);
  }

  return newlyApplied;
}

let cleanupTimer = null;
function startSessionCleanup(intervalMs = 300000) {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(async () => {
    try {
      await query('DELETE FROM sessions WHERE expires_at < NOW()');
    } catch (err) {
      // Quietly ignore transient errors during cleanup
    }
  }, intervalMs);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function stopSessionCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = {
  get pool() { return getPool(); },
  getPool,
  setPool,
  query,
  withTransaction,
  runMigrations,
  startSessionCleanup,
  stopSessionCleanup,
};
