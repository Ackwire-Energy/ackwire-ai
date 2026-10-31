import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED, migrationProblems, unsafeStatements } from "./check-migrations";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("drops, renames, type changes, SET NOT NULL and new NOT NULL columns without a default are caught by line, unless their statement says nothing needs it", () => {
  expect(unsafeStatements(read("scripts/check-migrations.fixture.sql"))).toEqual([
    "8: drops",
    "9: drops",
    "10: drops",
    "11: renames",
    "12: renames",
    "13: changes a column's type",
    "14: changes a column's type",
    "15: sets NOT NULL",
    "16: drops",
    // The marker covers its own statement, not the next ones: on the line before it or at the end of its line.
    "20: drops",
    "22: drops",
    "23: adds a NOT NULL column without a default",
  ]);
});

test("migrations from before the check: the ones that dropped would have been caught, one that only adds passes", () => {
  expect(unsafeStatements(read("packages/db/migrations/0111_drop_provisioning_delayed_at.sql"))).toEqual(["1: drops"]);
  expect(unsafeStatements(read("packages/db/migrations/0118_drop_cloud_sandboxes.sql"))).toEqual([
    "1: drops",
    "2: drops",
    "3: changes a column's type",
    "7: drops",
    "10: changes a column's type",
    "11: drops",
    "12: drops",
    "13: drops",
  ]);
  expect(unsafeStatements(read("packages/db/migrations/0119_agent_audit.sql"))).toEqual([]);
});

test("0130_roles changes types unmarked and passes only as a named exception, a new unmarked type change fails", () => {
  const roles = read("packages/db/migrations/0130_roles.sql");
  expect(unsafeStatements(roles)).toHaveLength(9);
  expect(Object.keys(ACCEPTED)).toEqual(["0130_roles.sql"]);
  expect(migrationProblems("packages/db/migrations/0130_roles.sql", roles)).toEqual([]);
  const later = "packages/db/migrations/0133_member_role_text.sql";
  expect(
    migrationProblems(later, 'ALTER TABLE "organization_members" ALTER COLUMN "role" SET DATA TYPE text;'),
  ).toEqual([`${later}:1: changes a column's type`]);
});
