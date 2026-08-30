import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

export interface MigrationOutcome {
  /** Migrations whose SQL was executed on this call. */
  applied: number[];
  /** Migrations recorded as already applied without execution (legacy baseline). */
  stamped: number[];
}

interface MigrationFile {
  id: number;
  name: string;
  sql: string;
}

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** Cluster-wide advisory-lock key serialising migration runs (incl. role DDL). */
export const MIGRATION_LOCK_KEY = 20260830;
const LOCK_KEY = MIGRATION_LOCK_KEY;

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../db/migrations", import.meta.url));
}

export async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((name) => FILE_PATTERN.test(name)).sort();
  const migrations: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const name of entries) {
    const id = Number(name.slice(0, 4));
    if (seen.has(id)) {
      throw new Error(`Duplicate migration number ${id} in ${directory}`);
    }
    seen.add(id);
    migrations.push({ id, name, sql: await readFile(`${directory}/${name}`, "utf8") });
  }
  return migrations;
}

export async function runMigrations(admin: Pool, directory: string = defaultMigrationsDir()): Promise<MigrationOutcome> {
  const client = await admin.connect();
  try {
    // Serialize concurrent starters (server boot, tests) on one cluster.
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      return await applyMigrations(client, directory);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function applyMigrations(client: PoolClient, directory: string): Promise<MigrationOutcome> {
  const migrations = await loadMigrationFiles(directory);
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id integer PRIMARY KEY,
       name text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const appliedRows = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  const done = new Set(appliedRows.rows.map((row) => Number(row.id)));
  const outcome: MigrationOutcome = { applied: [], stamped: [] };

  // Databases provisioned before versioned migrations received the Alpha
  // baseline wholesale. Record 0001 as applied instead of re-executing it
  // (add-only compatibility policy: never rewrite a live schema).
  if (done.size === 0) {
    const legacy = await client.query<{ reg: string | null }>(
      "SELECT to_regclass('public.app_users') AS reg",
    );
    const baseline = migrations.find((migration) => migration.id === 1);
    if (legacy.rows[0]?.reg !== null && baseline !== undefined) {
      await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
        baseline.id,
        baseline.name,
      ]);
      done.add(baseline.id);
      outcome.stamped.push(baseline.id);
    }
  }

  for (const migration of migrations) {
    if (done.has(migration.id)) {
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
        migration.id,
        migration.name,
      ]);
      await client.query("COMMIT");
      outcome.applied.push(migration.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outcome;
}
