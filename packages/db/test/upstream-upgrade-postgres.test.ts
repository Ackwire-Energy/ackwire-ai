import { expect, test } from "bun:test";
import { createDatabase, migrationsFolder } from "../src/client";
import { assertMigrationsMatch } from "../src/migration-guard";
import {
  prepareUpgradeFixture,
  type UpgradeFixtureDatabase,
  upgradeAndVerifyFixture,
  verifyLegacyUpgradeFixture,
} from "./upstream-upgrade-fixture";

const url = process.env.UPGRADE_REHEARSAL_DATABASE_URL;
const phase = process.env.UPGRADE_REHEARSAL_PHASE;
const baseline = process.env.UPGRADE_REHEARSAL_BASELINE ?? "0251";

function rehearsalTarget(url: string | undefined, phase: string | undefined, ci: string | undefined): string {
  if (!url || ci !== "true") throw new Error("The upgrade rehearsal requires its explicit CI-only URL");
  const at = new URL(url);
  if (
    at.protocol !== "postgres:" ||
    at.hostname !== "postgres" ||
    at.port !== "5432" ||
    at.username !== "agentes" ||
    at.search ||
    at.hash ||
    !["/ackwire_upgrade_ci", "/ackwire_upgrade_restored_ci"].includes(at.pathname)
  )
    throw new Error("The upgrade rehearsal accepts only its disposable Compose databases");
  if (!["prepare", "upgrade", "restored"].includes(phase ?? "")) throw new Error("Unknown upgrade rehearsal phase");
  if (at.pathname !== (phase === "restored" ? "/ackwire_upgrade_restored_ci" : "/ackwire_upgrade_ci"))
    throw new Error("The rehearsal phase does not match its disposable database");
  return url;
}

test("the upgrade rehearsal refuses deployed databases and mismatched phases", () => {
  const safe = "postgres://agentes:synthetic@postgres:5432/ackwire_upgrade_ci";
  expect(rehearsalTarget(safe, "prepare", "true")).toBe(safe);
  expect(() => rehearsalTarget(safe, "prepare", undefined)).toThrow();
  expect(() => rehearsalTarget(safe, "restored", "true")).toThrow();
  expect(() => rehearsalTarget(safe, "unknown", "true")).toThrow();
  for (const unsafe of [
    safe.replace("ackwire_upgrade_ci", "agentes"),
    safe.replace("@postgres:", "@production.example:"),
    `${safe}?host=production.example`,
    safe.replace("postgres:", "postgresql:"),
  ])
    expect(() => rehearsalTarget(unsafe, "prepare", "true")).toThrow();
});

/**
 * Invoked only by CI's Compose job. Never takes DATABASE_URL or TEST_DATABASE_URL: these two disposable names on
 * that job's internal `postgres` service are the only permitted targets. The test never creates/drops a database.
 * Compose dumps the selected synthetic baseline database before `upgrade`, then restores it into the other name for `restored`.
 */
test.skipIf(!url && !phase)(
  "isolated PostgreSQL upgrade and pre-upgrade backup restoration",
  async () => {
    const target = rehearsalTarget(url, phase, process.env.CI);
    if (baseline !== "0251" && baseline !== "0285") throw new Error("Unknown upgrade rehearsal baseline");

    const handle = createDatabase({ url: target, poolMax: 1 });
    const client = handle.client;
    if (!client) throw new Error("The rehearsal must use a real PostgreSQL server");
    const pg: UpgradeFixtureDatabase = {
      exec: (statement) => client.unsafe(statement),
      query: async <T>(statement: string) => ({ rows: [...(await client.unsafe(statement))] as T[] }),
    };
    try {
      // Check actual pgvector, not only that the fixture runs against PostgreSQL.
      if (phase === "prepare") {
        expect(
          (
            await pg.query(
              "select count(*)::int as n from information_schema.tables where table_schema in ('public', 'drizzle')",
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
        await prepareUpgradeFixture(handle.db, pg, baseline);
      }
      await verifyLegacyUpgradeFixture(pg, baseline);
      expect((await pg.query("select '[1,2,3]'::vector <-> '[1,2,4]'::vector as distance")).rows).toEqual([
        { distance: 1 },
      ]);
      if (phase !== "prepare") {
        await assertMigrationsMatch(handle.db, migrationsFolder);
        // The deployed stepped migrator handles concurrent index builds outside a transaction; the shared fixture
        // verifies the whole bounded upgrade, the intermediate nondefault approval, and a second no-op migration.
        await upgradeAndVerifyFixture(handle.db, pg, baseline);
        await assertMigrationsMatch(handle.db, migrationsFolder);
      }
    } finally {
      await handle.close();
    }
  },
  180_000,
);
