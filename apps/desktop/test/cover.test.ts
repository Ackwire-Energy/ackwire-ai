import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COVER = join(import.meta.dir, "../src/cover");
const read = (file: string) => readFileSync(file, "utf8");

test("the cover names only fonts its own page loads (it doesn't load the app's styles)", () => {
  const sheets = [...read(join(COVER, "main.ts")).matchAll(/^import "([^"]+\.css)";$/gm)].map((m) =>
    read(Bun.resolveSync(m[1] as string, COVER)),
  );
  const loaded = sheets.flatMap((css) =>
    [...css.matchAll(/@font-face\s*{[^}]*?font-family:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
  );
  const named = [...read(join(COVER, "cover.css")).matchAll(/font(?:-family)?:([^;]+);/g)].flatMap((m) =>
    [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((q) => q[1]),
  );
  expect(named.length).toBeGreaterThan(0);
  for (const family of named) expect(loaded).toContain(family);
});
