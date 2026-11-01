import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FIRST_STEP_SCREENS } from "../../src/features/chats/logic";

const APP = join(import.meta.dir, "..", "..", "app", "(app)");

test("each of Conversas' first steps opens a screen the app has (ADR 0108)", () => {
  expect(Object.keys(FIRST_STEP_SCREENS).sort()).toEqual(["agent", "ai", "ask", "routine", "team"]);
  for (const { href } of Object.values(FIRST_STEP_SCREENS)) {
    const route = join(APP, href);
    expect(existsSync(`${route}.tsx`) || existsSync(join(route, "index.tsx"))).toBe(true);
  }
});
