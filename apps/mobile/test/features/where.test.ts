import { describe, expect, test } from "bun:test";
import { whereAction } from "../../src/features/auth/where";

describe("Onde fica o seu workspace? on the phone", () => {
  test("the Cloud: nothing to change on it, a move to it elsewhere; one's own server: its address screen", () => {
    expect(whereAction("cloud", true)).toBe("close");
    expect(whereAction("cloud", false)).toBe("cloud");
    expect(whereAction("own", true)).toBe("address");
    expect(whereAction("own", false)).toBe("address");
  });
});
