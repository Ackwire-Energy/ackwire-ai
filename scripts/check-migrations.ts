/**
 * New migrations keep the running version working, run in CI via `bun run check:migrations`. A deploy migrates
 * while the previous version still serves (deploy/deploy.sh), and a rollback runs that version on the migrated
 * database, so a migration may not take away or change what it reads. A statement that drops, renames, changes a
 * column's type or sets NOT NULL goes in only once no running version reads the object, with a comment in the
 * statement that says so:
 *   -- deploy-safe: nothing reads "delayed_at" since the release before this one
 *   ALTER TABLE "machine_provisioning" DROP COLUMN "delayed_at";
 */
import { basename } from "node:path";
import { Glob } from "bun";

/** Migrations up to this number came before the check. */
export const CHECKED_AFTER = 119;

const MARKER = /--\s*deploy-safe:\s*\S/;

const UNSAFE: [RegExp, string][] = [
  // DROP NOT NULL only relaxes a column: what the previous version reads and writes still works.
  [/\bDROP\b(?!\s+NOT\s+NULL\b)/i, "drops"],
  [/\bRENAME\b/i, "renames"],
  [/\bALTER\s+(?:COLUMN\s+)?(?:""|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/i, "changes a column's type"],
  [/\bSET\s+NOT\s+NULL\b/i, "sets NOT NULL"],
];

/** Text, quoted names and comments: their words aren't SQL. */
const NOT_SQL = /'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*/g;

/** The statements of a migration that a running version may break on, unmarked, as `line: what it does`. */
export function unsafeStatements(sql: string): string[] {
  const hits: string[] = [];
  let line = 1;
  for (const statement of sql.split(/;[ \t]*(?:--> statement-breakpoint)?[ \t]*$/m)) {
    if (!MARKER.test(statement)) {
      // Line breaks stay where they were, so a hit's line is right.
      const code = statement.replace(NOT_SQL, (m) =>
        m.startsWith("--") ? "" : `${m[0]}${m.replace(/[^\n]/g, "")}${m[0]}`,
      );
      for (const [pattern, what] of UNSAFE) {
        const hit = pattern.exec(code);
        if (hit) hits.push(`${line + (code.slice(0, hit.index).match(/\n/g)?.length ?? 0)}: ${what}`);
      }
    }
    line += statement.match(/\n/g)?.length ?? 0;
  }
  return hits;
}

if (import.meta.main) {
  const problems: string[] = [];
  for (const file of [...new Glob("packages/db/migrations/*.sql").scanSync()].sort()) {
    if (Number.parseInt(basename(file), 10) <= CHECKED_AFTER) continue;
    for (const hit of unsafeStatements(await Bun.file(file).text())) problems.push(`${file}:${hit}`);
  }
  if (problems.length > 0) {
    console.error(
      "A deploy migrates while the previous version still serves, and a rollback runs it on the migrated database." +
        " These statements take away or change what a running version may read:",
    );
    console.error(problems.join("\n"));
    console.error(
      "Deploy the code that stops reading it first. Then a later migration does it, with a comment line in the" +
        " statement: -- deploy-safe: <why no running version reads it>",
    );
    process.exit(1);
  }
  console.log("migrations ok");
}
