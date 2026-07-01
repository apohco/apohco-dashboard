const { Pool } = require('pg');
const { getSecretJson } = require('./secretsManager');

// Cached across warm Lambda invocations so we don't open a new connection
// pool (or re-fetch credentials) on every request.
let poolPromise = null;

async function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      const { username, password } = await getSecretJson(process.env.DB_CREDENTIALS_SECRET_ARN);
      return new Pool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        database: process.env.DB_NAME,
        user: username,
        password,
        max: 3,
        ssl: { rejectUnauthorized: false },
      });
    })();
  }
  return poolPromise;
}

async function query(text, params) {
  const pool = await getPool();
  return pool.query(text, params);
}

// Runs `fn(client)` inside a BEGIN/COMMIT transaction, rolling back on error.
async function withTransaction(fn) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction };
