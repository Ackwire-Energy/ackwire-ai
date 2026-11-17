import { test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrateInSteps, migrationsFolder } from "../src/client";
import {
  seedUpgradeFixture,
  upgradeAndVerifyFixture,
  upgradeBoundaries,
  verifyLegacyUpgradeFixture,
} from "./upstream-upgrade-fixture";

/** Rehearse the Ackwire 0251 database upgrading through the upstream merge's 31 migrations. */
test("the upstream upgrade preserves existing data and deliberate role restrictions", async () => {
  const pg = new PGlite({ extensions: { vector } });
  try {
    const db = drizzle(pg);
    await migrateInSteps(db, migrationsFolder, upgradeBoundaries().before);
    await seedUpgradeFixture(pg);
    await verifyLegacyUpgradeFixture(pg);
    await upgradeAndVerifyFixture(db, pg);
  } finally {
    await pg.close();
  }
}, 180_000);
