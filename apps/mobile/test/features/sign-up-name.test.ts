import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikePassword, nameIsPassword } from "@agenteschat/client/lib/text";

/* Every phone flow that makes an account (or a request that becomes one) refuses a password equal to the name. */

const source = (file: string) => readFileSync(join(import.meta.dir, "../../src/features/auth", file), "utf8");
const GUARD =
  /nameIsPassword\(name, password\)\) \{\s*(?:\/\/[^\n]*\s*)?setPassword\(""\);\s*go\("name"\);\s*setError\(t\("auth\.flow\.nameIsPassword"\)\);/;

describe("a password typed as the name, on the phone", () => {
  for (const [file, onward] of [
    ["AuthFlow.tsx", "void signUp()"],
    ["EmailSteps.tsx", "void signUp()"],
    ["LinkSteps.tsx", 'go("note")'],
  ] as const)
    test(`${file}: back on the name before the account, and the soft hint on the name`, () => {
      const code = source(file);
      const guard = code.search(GUARD);
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(code.indexOf(onward, guard));
      expect(code).toContain("<NameHint name={name} />");
    });

  test("what the guard and the hint go by", () => {
    expect(nameIsPassword("Admin$10", "Admin$10")).toBe(true);
    expect(nameIsPassword("Ana Souza", "Admin$10")).toBe(false);
    expect(looksLikePassword("Admin$10")).toBe(true);
    expect(looksLikePassword("Ana 2")).toBe(false);
  });
});
