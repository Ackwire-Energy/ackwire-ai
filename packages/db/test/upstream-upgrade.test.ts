import { test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { prepareUpgradeFixture, upgradeAndVerifyFixture, verifyLegacyUpgradeFixture } from "./upstream-upgrade-fixture";

for (const baseline of ["0251", "0285"] as const) {
  test(`the ${baseline} upgrade preserves data, role restrictions and owner preferences`, async () => {
    const pg = new PGlite({ extensions: { vector } });
    try {
      const db = drizzle(pg);
      await prepareUpgradeFixture(db, pg, baseline);
      await verifyLegacyUpgradeFixture(pg, baseline);
      await upgradeAndVerifyFixture(db, pg, baseline);
    } finally {
      await pg.close();
    }
  }, 180_000);
}
