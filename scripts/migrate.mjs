import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'supabase', 'migrations');
const files = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
const urls = [process.env.POSTGRES_URL_NON_POOLING, process.env.POSTGRES_URL].filter(Boolean);
if (!urls.length) throw new Error('POSTGRES_URL_NON_POOLING 또는 POSTGRES_URL이 필요합니다.');

let client;
const connectionErrors = [];
for (const connectionString of urls) {
  const url = new URL(connectionString);
  if (process.env.DB_SSL_CA_PATH) {
    url.searchParams.set('sslmode', 'verify-full');
    url.searchParams.set('sslrootcert', process.env.DB_SSL_CA_PATH);
  } else if (url.searchParams.get('sslmode') === 'require') {
    // node-postgres currently interprets "require" as verify-full; libpq compatibility
    // keeps TLS required when the provider certificate is not installed locally.
    url.searchParams.set('uselibpqcompat', 'true');
  }
  const candidate = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  try {
    await candidate.connect();
    client = candidate;
    break;
  } catch (error) {
    connectionErrors.push(error.code ?? error.name);
    await candidate.end().catch(() => {});
  }
}
if (!client) throw new Error(`Supabase DB에 연결할 수 없습니다 (${connectionErrors.join(', ')}).`);

try {
  await client.query('create schema if not exists app_internal');
  await client.query(`create table if not exists app_internal.schema_migrations (
    filename text primary key,
    applied_at timestamptz not null default now()
  )`);
  for (const filename of files) {
    await client.query('begin');
    try {
      await client.query('select pg_advisory_xact_lock(78214301)');
      const existing = await client.query('select 1 from app_internal.schema_migrations where filename = $1', [filename]);
      if (existing.rowCount) {
        await client.query('commit');
        console.log(`Already applied: ${filename}`);
        continue;
      }
      const raw = await readFile(path.join(directory, filename), 'utf8');
      const sql = raw.replace(/^\s*(begin|commit);\s*$/gim, '');
      await client.query(sql);
      await client.query('insert into app_internal.schema_migrations(filename) values($1)', [filename]);
      await client.query('commit');
      console.log(`Applied: ${filename}`);
    } catch (error) {
      await client.query('rollback');
      throw new Error(`Migration failed: ${filename} (${error.code ?? 'SQL error'})`, { cause: error });
    }
  }
} finally {
  await client.end();
}
