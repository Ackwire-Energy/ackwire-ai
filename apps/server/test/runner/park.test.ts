import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { bootId } from "../../runner/lock";
import { ackPark, askPark, PARK_FILE, parkDone, takePark } from "../../runner/park";
import { removeDirs, tempDir } from "./helpers";

/** An operator's park: idle desktops parked and idle browsers eased, asked in a file and answered in another. */

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

test("a park is taken once, only in the boot it was asked in, and answered with what was done", () => {
  const home = tempDir();
  dirs.push(home);
  const ask = askPark(home);
  expect(parkDone(home, ask.id)).toBeNull();
  expect(takePark(home)).toEqual({ id: ask.id, boot: bootId() });
  // Taken: a runner started later never parks for it.
  expect(existsSync(path.join(home, PARK_FILE))).toBe(false);
  expect(takePark(home)).toBeNull();
  ackPark(home, { id: ask.id, desktops: 2, browsers: 1 });
  expect(parkDone(home, ask.id)).toEqual({ id: ask.id, desktops: 2, browsers: 1 });
  expect(parkDone(home, "another")).toBeNull();
  // Asked in another boot: void, and gone.
  askPark(home);
  expect(takePark(home, "another-boot")).toBeNull();
  expect(existsSync(path.join(home, PARK_FILE))).toBe(false);
});
