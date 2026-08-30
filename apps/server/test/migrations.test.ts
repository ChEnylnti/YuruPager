import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { loadConfig } from "../src/config.js";
import { MIGRATION_LOCK_KEY, runMigrations } from "../src/migrations.js";

const config = loadConfig({ ...process.env });
const admin = new Pool({ connectionString: config.adminDatabaseUrl, max: 1 });

const scratchDatabases: string[] = [];
let fixtureDir = "";

function scratchUrl(name: string): string {
  const url = new URL(config.adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createScratchDatabase(name: string): Promise<Pool> {
  scratchDatabases.push(name);
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  return new Pool({ connectionString: scratchUrl(name), max: 1 });
}

async function dropScratchDatabases(): Promise<void> {
  for (const name of scratchDatabases) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

describe("versioned migrations", () => {
  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "yurupager-migrations-"));
  }, 60_000);

  afterAll(async () => {
    await dropScratchDatabases();
    await admin.end();
    await rm(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("initialises a fresh database in one shot and stays idempotent", async () => {
    const database = await createScratchDatabase("yuru_mig_test_fresh");
    try {
      const first = await runMigrations(database);
      expect(first).toEqual({ applied: [1], stamped: [] });
      const applied = await database.query<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id");
      expect(applied.rows.map((row) => Number(row.id))).toEqual([1]);
      for (const table of ["app_users", "workspaces", "agent_requests", "push_subscriptions"]) {
        expect((await database.query(`SELECT to_regclass('public.${table}') AS reg`)).rows[0]?.reg).not.toBeNull();
      }

      const second = await runMigrations(database);
      expect(second).toEqual({ applied: [], stamped: [] });
    } finally {
      await database.end();
    }
  }, 60_000);

  it("stamps a pre-versioning database instead of re-executing the baseline", async () => {
    const database = await createScratchDatabase("yuru_mig_test_legacy");
    try {
      // Simulate the original bootstrap: the Alpha baseline executed wholesale
      // with no migration history recorded. Take the migration advisory lock
      // so role DDL cannot race a parallel runMigrations() on this cluster.
      const baseline = await readFile(new URL("../db/migrations/0001_initial_alpha_schema.sql", import.meta.url), "utf8");
      await database.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      try {
        await database.query(baseline);
      } finally {
        await database.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      }
      expect(
        (await database.query("SELECT to_regclass('public.schema_migrations') AS reg")).rows[0]?.reg,
      ).toBeNull();

      const outcome = await runMigrations(database);
      expect(outcome).toEqual({ applied: [], stamped: [1] });
      const applied = await database.query<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id");
      expect(applied.rows.map((row) => Number(row.id))).toEqual([1]);
    } finally {
      await database.end();
    }
  }, 60_000);

  it("applies pending migrations in order, rolls back failures, and resumes", async () => {
    const database = await createScratchDatabase("yuru_mig_test_runner");
    try {
      await writeFile(join(fixtureDir, "0002_add_label.sql"), [
        "ALTER TABLE fixture_items ADD COLUMN IF NOT EXISTS label text;",
      ].join("\n"));
      await writeFile(join(fixtureDir, "0001_create_items.sql"), [
        "CREATE TABLE IF NOT EXISTS fixture_items (id integer PRIMARY KEY);",
      ].join("\n"));

      const first = await runMigrations(database, fixtureDir);
      expect(first.applied).toEqual([1, 2]);
      expect(
        (await database.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'fixture_items' AND column_name = 'label'")).rowCount,
      ).toBe(1);

      // A failing migration must roll back completely and leave no tracking row.
      await writeFile(join(fixtureDir, "0003_broken.sql"), "SELECT * FROM fixture_missing");
      await expect(runMigrations(database, fixtureDir)).rejects.toThrow(/0003_broken\.sql/);
      expect(
        (await database.query("SELECT id FROM schema_migrations WHERE id = 3")).rowCount,
      ).toBe(0);

      // Replacing the failed migration with a valid one resumes from 0003.
      await writeFile(join(fixtureDir, "0003_broken.sql"), "INSERT INTO fixture_items (id, label) VALUES (1, 'resumed')");
      const resumed = await runMigrations(database, fixtureDir);
      expect(resumed.applied).toEqual([3]);
      expect(
        (await database.query<{ label: string }>("SELECT label FROM fixture_items WHERE id = 1")).rows[0]?.label,
      ).toBe("resumed");

      const final = await runMigrations(database, fixtureDir);
      expect(final).toEqual({ applied: [], stamped: [] });
    } finally {
      await database.end();
    }
  }, 60_000);
});
