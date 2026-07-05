// One-off migration runner: applies any .sql files in ./migrations that
// haven't been applied yet, in filename order, tracked in a
// schema_migrations table. Run via `npm run db:migrate` from backend/.
// Requires DB_HOST, DB_NAME, DB_PORT (optional), DB_USER, DB_PASSWORD env vars.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Exported separately from the CLI entrypoint below so it can be reused by
// anything that already has a connected `client` (e.g. a one-off Lambda
// running inside the VPC with credentials from Secrets Manager, rather than
// raw DB_USER/DB_PASSWORD env vars).
async function applyMigrations(client) {
  const log = [];
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await client.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      log.push(`skip (already applied): ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log.push(`applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }

  return log;
}

async function run() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const log = await applyMigrations(client);
    log.forEach((line) => console.log(line));
    console.log('Migrations complete.');
  } finally {
    await client.end();
  }
}

module.exports = { applyMigrations };

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
