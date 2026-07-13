import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  console.log('🔄 Running migrations...');

  // Create migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const migrationsDir = resolve(__dirname, '../../../migrations');
  const migrationFile = '001_init.sql';

  const applied = await sql<[{ name: string }]>`
    SELECT name FROM _migrations WHERE name = ${migrationFile}
  `;

  if (applied.length > 0) {
    console.log(`✅ Migration ${migrationFile} already applied`);
  } else {
    const sqlContent = readFileSync(resolve(migrationsDir, migrationFile), 'utf-8');
    await sql.unsafe(sqlContent);
    await sql`INSERT INTO _migrations (name) VALUES (${migrationFile})`;
    console.log(`✅ Applied migration: ${migrationFile}`);
  }

  await sql.end();
  console.log('✅ Migrations complete');
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
