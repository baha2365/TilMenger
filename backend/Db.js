const { Pool } = require('pg');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL;

// If DATABASE_URL is set (e.g. Neon in production), use it.
// Otherwise, fall back to discrete local Postgres settings.
const poolConfig = connectionString
  ? {
      connectionString,
      // Neon requires SSL. `rejectUnauthorized: false` is the standard
      // approach for Neon's pooled connections since they use a
      // certificate chain that isn't always in Node's default trust store.
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME     || 'ai_english_teacher',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: false,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Verify the database connection on startup.
 */
async function connectDB() {
  const client = await pool.connect();
  const { rows } = await client.query('SELECT NOW() AS now');
  client.release();

  const target = connectionString ? 'Neon (DATABASE_URL)' : `${poolConfig.host}:${poolConfig.port}/${poolConfig.database}`;
  console.log(`✅  PostgreSQL connected [${target}] — server time: ${rows[0].now}`);
}

module.exports = { pool, connectDB };