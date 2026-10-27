import { expect, test } from "bun:test";
import { join } from "node:path";
import { unplainServerWords } from "../../../packages/i18n/test/plain-marks";

const REPO = join(import.meta.dir, "..", "..", "..");

test("the API's error words: no semicolon, no em dash", () => {
  expect(unplainServerWords(["apps/server/src", "packages/engine/src"].map((d) => join(REPO, d)))).toEqual([]);
});
